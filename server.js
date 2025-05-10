require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const util = require('util');
const stream = require('stream');
const pipeline = util.promisify(stream.pipeline);

// Initialize Express app
const app = express();

// Important for Railway: Use the PORT environment variable
const PORT = process.env.PORT || 3000;

// Configure middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// Configure PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize database
async function initializeDatabase() {
  const client = await pool.connect();
  try {
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
  } catch (err) {
    console.error('Error initializing database:', err);
  } finally {
    client.release();
  }
}

// Call initialization when server starts
initializeDatabase().catch(console.error);

// Basic route to verify server is running
app.get('/', (req, res) => {
  res.json({ message: 'Image Host API is running!' });
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
      }
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

// Store image in the database
async function storeImage(symbol, imagePath, filename) {
  const client = await pool.connect();
  try {
    // Read the image file
    const imageBuffer = fs.readFileSync(imagePath);
    
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
    client.release();
  }
}

// Endpoint to download and store Finviz chart
app.post('/charts', async (req, res) => {
  try {
    const { symbol } = req.body;
    
    if (!symbol) {
      return res.status(400).json({ error: 'Symbol is required' });
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
  try {
    const { symbol } = req.params;
    const client = await pool.connect();
    
    try {
      const result = await client.query(
        'SELECT image_data, filename FROM images WHERE symbol = $1',
        [symbol.toUpperCase()]
      );
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Chart not found' });
      }
      
      const { image_data, filename } = result.rows[0];
      
      res.set('Content-Type', 'image/png');
      res.set('Content-Disposition', `inline; filename="${filename}"`);
      return res.send(image_data);
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error retrieving chart:', error);
    res.status(500).json({ error: 'Failed to retrieve chart', details: error.message });
  }
});

// Endpoint to get all available symbols
app.get('/symbols', async (req, res) => {
  try {
    const client = await pool.connect();
    
    try {
      const result = await client.query(
        'SELECT symbol, created_at, updated_at FROM images ORDER BY symbol'
      );
      
      res.json({
        symbols: result.rows,
        count: result.rows.length
      });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error retrieving symbols:', error);
    res.status(500).json({ error: 'Failed to retrieve symbols', details: error.message });
  }
});

// Batch process multiple symbols
app.post('/batch-charts', async (req, res) => {
  try {
    const { symbols } = req.body;
    
    if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
      return res.status(400).json({ error: 'Valid symbols array is required' });
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

// Health check endpoint (important for Railway)
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Database connection test endpoint
app.get('/db-test', async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW()');
    client.release();
    res.json({ success: true, time: result.rows[0] });
  } catch (err) {
    console.error('Database connection error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  // Close resources here
  pool.end();
  process.exit(0);
});

// Unhandled rejection handling
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
