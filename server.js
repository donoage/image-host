require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const util = require('util');
const stream = require('stream');
const pipeline = util.promisify(stream.pipeline);
const multer = require('multer');

// Initialize Express app
const app = express();

// Important for Railway: Use the PORT environment variable
const PORT = process.env.PORT || 3000;

// Configure middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// Configure PostgreSQL connection - Only if DATABASE_URL is available
let pool = null;
let dbInitialized = false;

try {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      // Add connection pool configuration to prevent overwhelming the DB
      max: 20, 
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
    console.log('Database pool created');
  } else {
    console.log('No DATABASE_URL provided, running without database functionality');
  }
} catch (error) {
  console.error('Error creating database pool:', error);
}

// Initialize database
async function initializeDatabase() {
  if (!pool) {
    console.log('Skipping database initialization - no database connection');
    return false;
  }
  
  let client = null;
  try {
    client = await pool.connect();
    // Create images table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS images (
        id SERIAL PRIMARY KEY,
        symbol VARCHAR(10) NOT NULL,
        image_data BYTEA NOT NULL,
        filename VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('Database initialized successfully');
    dbInitialized = true;
    return true;
  } catch (err) {
    console.error('Error initializing database:', err);
    return false;
  } finally {
    if (client) client.release();
  }
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, 'public', 'static');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    // Use the original filename or generate from ticker
    const filename = req.body.filename || file.originalname;
    cb(null, filename);
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: function (req, file, cb) {
    // Only allow PNG files
    if (file.mimetype === 'image/png') {
      cb(null, true);
    } else {
      cb(new Error('Only PNG files are allowed'), false);
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  }
});

// Basic route to verify server is running - doesn't require DB
app.get('/', (req, res) => {
  res.json({ 
    message: 'Image Host API is running!',
    time: new Date().toISOString(),
    dbStatus: pool ? (dbInitialized ? 'Connected and initialized' : 'Connected but not initialized') : 'No database connection'
  });
});

// Health check endpoint - critical for Railway, doesn't require DB
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Download Finviz chart
async function downloadFinvizChart(symbol) {
  try {
    // Format ticker symbol
    const formattedSymbol = symbol.toUpperCase();
    
    // Finviz chart URL format
    const url = `https://finviz.com/chart.ashx?t=${formattedSymbol}&ty=c&ta=1&p=d&s=l`;
    
    // Set up a temporary file path
    const tempPath = path.join(__dirname, 'temp', `${formattedSymbol}_chart.png`);
    
    // Make sure temp directory exists
    if (!fs.existsSync(path.join(__dirname, 'temp'))) {
      fs.mkdirSync(path.join(__dirname, 'temp'), { recursive: true });
    }
    
    // Download the image
    const response = await axios({
      method: 'get',
      url: url,
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36'
      },
      timeout: parseInt(process.env.DOWNLOAD_TIMEOUT_MS || 30000)
    });
    
    // Save to temporary file
    await pipeline(response.data, fs.createWriteStream(tempPath));
    
    return {
      path: tempPath,
      filename: `${formattedSymbol}_chart.png`
    };
  } catch (error) {
    console.error(`Error downloading Finviz chart for ${symbol}:`, error);
    throw error;
  }
}

// Database status endpoint
app.get('/db-status', async (req, res) => {
  if (!pool) {
    return res.status(200).json({ 
      status: 'No database connection configured',
      initialized: false
    });
  }
  
  let client = null;
  try {
    client = await pool.connect();
    const result = await client.query('SELECT NOW()');
    res.json({ 
      status: 'Connected',
      initialized: dbInitialized,
      serverTime: result.rows[0].now
    });
  } catch (err) {
    console.error('Database status check error:', err);
    res.status(200).json({ 
      status: 'Error connecting to database',
      error: err.message,
      initialized: dbInitialized
    });
  } finally {
    if (client) client.release();
  }
});

// Only register these routes if we have a database connection
if (pool) {
  // Store image in the database
  async function storeImage(symbol, imagePath, filename) {
    let client = null;
    try {
      // Read the image file
      const imageBuffer = fs.readFileSync(imagePath);
      
      client = await pool.connect();
      
      // Check if image for this symbol already exists
      const checkResult = await client.query(
        'SELECT id FROM images WHERE symbol = $1',
        [symbol]
      );
      
      if (checkResult.rows.length > 0) {
        // Update existing image
        await client.query(
          'UPDATE images SET image_data = $1, filename = $2, updated_at = CURRENT_TIMESTAMP WHERE symbol = $3',
          [imageBuffer, filename, symbol]
        );
        return { updated: true, symbol };
      } else {
        // Insert new image
        await client.query(
          'INSERT INTO images (symbol, image_data, filename) VALUES ($1, $2, $3)',
          [symbol, imageBuffer, filename]
        );
        return { inserted: true, symbol };
      }
    } finally {
      if (client) client.release();
    }
  }

  // Endpoint to download and store Finviz chart
  app.post('/charts', async (req, res) => {
    try {
      const { symbol } = req.body;
      
      if (!symbol) {
        return res.status(400).json({ error: 'Symbol is required' });
      }
      
      if (!dbInitialized) {
        return res.status(503).json({ error: 'Database not yet initialized' });
      }
      
      // Download the chart
      const chart = await downloadFinvizChart(symbol);
      
      // Store in database
      const result = await storeImage(symbol, chart.path, chart.filename);
      
      // Clean up temporary file
      fs.unlinkSync(chart.path);
      
      res.json({
        success: true,
        ...result,
        message: `Chart for ${symbol} processed successfully`
      });
    } catch (error) {
      console.error('Error processing chart:', error);
      res.status(500).json({ error: 'Failed to process chart', details: error.message });
    }
  });

  // Endpoint to get chart by symbol
  app.get('/charts/:symbol', async (req, res) => {
    let client = null;
    try {
      const { symbol } = req.params;
      
      if (!dbInitialized) {
        return res.status(503).json({ error: 'Database not yet initialized' });
      }
      
      client = await pool.connect();
      
      const result = await client.query(
        'SELECT image_data, filename FROM images WHERE symbol = $1',
        [symbol.toUpperCase()]
      );
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Chart not found' });
      }
      
      const { image_data, filename } = result.rows[0];
      
      // Set headers required for compatibility with Notion and other services
      res.set('Content-Type', 'image/png');
      res.set('Content-Disposition', `inline; filename="${filename}"`);
      res.set('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
      res.set('Access-Control-Allow-Origin', '*'); // Allow cross-origin requests
      res.set('Access-Control-Allow-Methods', 'GET');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      res.set('X-Content-Type-Options', 'nosniff');
      
      // Send the binary data
      return res.send(image_data);
    } catch (error) {
      console.error('Error retrieving chart:', error);
      res.status(500).json({ error: 'Failed to retrieve chart', details: error.message });
    } finally {
      if (client) client.release();
    }
  });

  // Endpoint to get all available symbols
  app.get('/symbols', async (req, res) => {
    let client = null;
    try {
      if (!dbInitialized) {
        return res.status(503).json({ error: 'Database not yet initialized' });
      }
      
      client = await pool.connect();
      
      const result = await client.query(
        'SELECT symbol, created_at, updated_at FROM images ORDER BY symbol'
      );
      
      res.json({
        symbols: result.rows,
        count: result.rows.length
      });
    } catch (error) {
      console.error('Error retrieving symbols:', error);
      res.status(500).json({ error: 'Failed to retrieve symbols', details: error.message });
    } finally {
      if (client) client.release();
    }
  });

  // Batch process multiple symbols
  app.post('/batch-charts', async (req, res) => {
    try {
      const { symbols } = req.body;
      
      if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
        return res.status(400).json({ error: 'Valid symbols array is required' });
      }
      
      if (!dbInitialized) {
        return res.status(503).json({ error: 'Database not yet initialized' });
      }
      
      const results = [];
      const errors = [];
      
      // Process each symbol
      for (const symbol of symbols) {
        try {
          // Download the chart
          const chart = await downloadFinvizChart(symbol);
          
          // Store in database
          const result = await storeImage(symbol, chart.path, chart.filename);
          
          // Clean up temporary file
          fs.unlinkSync(chart.path);
          
          results.push({ symbol, success: true, ...result });
        } catch (error) {
          console.error(`Error processing ${symbol}:`, error);
          errors.push({ symbol, error: error.message });
        }
      }
      
      res.json({
        success: errors.length === 0,
        processed: results.length,
        failed: errors.length,
        results,
        errors
      });
    } catch (error) {
      console.error('Error in batch processing:', error);
      res.status(500).json({ error: 'Failed to process batch', details: error.message });
    }
  });

  // Database connection test endpoint
  app.get('/db-test', async (req, res) => {
    let client = null;
    try {
      client = await pool.connect();
      const result = await client.query('SELECT NOW()');
      res.json({ success: true, time: result.rows[0] });
    } catch (err) {
      console.error('Database connection error:', err);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      if (client) client.release();
    }
  });
} else {
  // If no database connection, add placeholders for these routes
  app.post('/charts', (req, res) => {
    res.status(503).json({ error: 'Database functionality not available' });
  });
  
  app.get('/charts/:symbol', (req, res) => {
    res.status(503).json({ error: 'Database functionality not available' });
  });
  
  app.get('/symbols', (req, res) => {
    res.status(503).json({ error: 'Database functionality not available' });
  });
  
  app.post('/batch-charts', (req, res) => {
    res.status(503).json({ error: 'Database functionality not available' });
  });
  
  app.get('/db-test', (req, res) => {
    res.status(503).json({ error: 'Database functionality not available' });
  });
}

// Upload endpoint for chart images
app.post('/upload', upload.single('image'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const filename = req.file.filename;
    const filePath = req.file.path;
    
    // Validate filename format (should be TICKER_chart.png)
    if (!filename.match(/^[A-Z0-9]+_chart\.png$/i)) {
      // Clean up the uploaded file
      fs.unlinkSync(filePath);
      return res.status(400).json({ 
        error: 'Invalid filename format. Expected: TICKER_chart.png' 
      });
    }

    // Extract ticker from filename
    const ticker = filename.split('_')[0].toUpperCase();
    
    console.log(`Successfully uploaded chart for ${ticker}: ${filename}`);
    
    // Return success response with the public URL
    const host = req.get('host');
    const publicUrl = `https://${host}/static/${filename}`;
    
    res.json({
      success: true,
      message: `Chart uploaded successfully for ${ticker}`,
      filename: filename,
      ticker: ticker,
      url: publicUrl,
      size: req.file.size
    });
    
  } catch (error) {
    console.error('Upload error:', error);
    
    // Clean up file if it exists
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.status(500).json({ 
      error: 'Upload failed', 
      details: error.message 
    });
  }
});

// Batch upload endpoint for multiple charts
app.post('/upload-batch', upload.array('images', 100), (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const results = [];
    const errors = [];
    const host = req.get('host');

    for (const file of req.files) {
      try {
        const filename = file.filename;
        
        // Validate filename format
        if (!filename.match(/^[A-Z0-9]+_chart\.png$/i)) {
          fs.unlinkSync(file.path);
          errors.push({
            filename: filename,
            error: 'Invalid filename format. Expected: TICKER_chart.png'
          });
          continue;
        }

        const ticker = filename.split('_')[0].toUpperCase();
        const publicUrl = `https://${host}/static/${filename}`;
        
        results.push({
          ticker: ticker,
          filename: filename,
          url: publicUrl,
          size: file.size
        });
        
        console.log(`Successfully uploaded chart for ${ticker}: ${filename}`);
        
      } catch (error) {
        console.error(`Error processing file ${file.filename}:`, error);
        
        // Clean up file
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
        
        errors.push({
          filename: file.filename,
          error: error.message
        });
      }
    }

    res.json({
      success: errors.length === 0,
      uploaded: results.length,
      failed: errors.length,
      results: results,
      errors: errors
    });
    
  } catch (error) {
    console.error('Batch upload error:', error);
    
    // Clean up any uploaded files
    if (req.files) {
      req.files.forEach(file => {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      });
    }
    
    res.status(500).json({ 
      error: 'Batch upload failed', 
      details: error.message 
    });
  }
});

// Create directories for static chart images
if (!fs.existsSync(path.join(__dirname, 'public', 'static'))) {
  fs.mkdirSync(path.join(__dirname, 'public', 'static'), { recursive: true });
}

// Special handler for direct chart image requests that might not exist yet
app.get('/static/:filename', async (req, res, next) => {
  try {
    // Check if this is a chart image request
    const filename = req.params.filename;
    if (!filename.match(/^[A-Z0-9]+_chart\.png$/i)) {
      return next(); // Not a chart image request, continue to normal static file handling
    }
    
    // Extract symbol from filename
    const symbol = filename.split('_')[0].toUpperCase();
    
    // Define paths
    const filePath = path.join(__dirname, 'public', 'static', filename);
    
    // Check if file exists and is recent (if exists, static middleware will handle it)
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      const fileAge = (new Date().getTime() - stats.mtime.getTime()) / 1000 / 60 / 60;
      
      if (fileAge < 24) {
        return next(); // Let static middleware serve the file
      }
    }
    
    // If we get here, we need to download the file
    console.log(`Auto-generating chart for ${symbol} from direct image request`);
    const chart = await downloadFinvizChart(symbol);
    fs.copyFileSync(chart.path, filePath);
    fs.unlinkSync(chart.path);
    
    // Serve the file directly instead of going through static middleware
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.sendFile(filePath);
  } catch (error) {
    console.error(`Error handling direct chart request:`, error);
    return res.status(500).send('Error generating chart image');
  }
});

// Direct image hosting endpoint - returns the URL as text
app.get('/static/charts/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const formattedSymbol = symbol.toUpperCase();
    const filePath = path.join(__dirname, 'public', 'static', `${formattedSymbol}_chart.png`);
    
    // Always use HTTPS for Railway app
    const host = req.get('host');
    const publicUrl = `https://${host}/static/${formattedSymbol}_chart.png`;
    
    // If file doesn't exist or is older than 24 hours, download a new one
    let needsDownload = true;
    
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      const fileAge = (new Date().getTime() - stats.mtime.getTime()) / 1000 / 60 / 60;
      
      if (fileAge < 24) {
        needsDownload = false;
      }
    }
    
    if (needsDownload) {
      console.log(`Downloading new chart for ${symbol}`);
      const chart = await downloadFinvizChart(symbol);
      fs.copyFileSync(chart.path, filePath);
      fs.unlinkSync(chart.path);
    }
    
    // Return just the URL as plain text, no newline at the end
    res.set('Content-Type', 'text/plain');
    return res.send(publicUrl);
    
  } catch (error) {
    console.error('Error handling static chart request:', error);
    res.status(500).json({ error: 'Failed to process chart request' });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// Start server
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
  // Try to initialize database after server starts, but don't block startup
  if (pool) {
    initializeDatabase().then(success => {
      console.log(`Database initialization ${success ? 'successful' : 'failed'}`);
    }).catch(err => {
      console.error('Error during database initialization:', err);
    });
  }
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('HTTP server closed');
    if (pool) {
      pool.end(() => {
        console.log('Database pool has ended');
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
  });
  
  // Force shutdown after 10 seconds if graceful shutdown fails
  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
});

// Handle SIGINT (Ctrl+C)
process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('HTTP server closed');
    if (pool) {
      pool.end(() => {
        console.log('Database pool has ended');
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
  });
});

// Unhandled rejection handling
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Uncaught exception handling
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  // Log the error but don't exit, let the server continue running
});
