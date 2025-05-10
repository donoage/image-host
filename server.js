// Load environment variables
require('dotenv').config();

const express = require('express');
const { Pool } = require('pg');
const app = express();
const port = process.env.PORT || 3000;

// Enable JSON parsing for requests
app.use(express.json({ limit: '10mb' }));

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// Basic route to show the server is running
app.get('/', (req, res) => {
  res.send('Image Host Server is running');
});

// Create table if not exists
app.get('/setup', async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS finviz_images (
        ticker TEXT PRIMARY KEY,
        image BYTEA,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    res.send('Database setup complete!');
  } catch (err) {
    console.error('Database setup error:', err);
    res.status(500).send('Database setup error: ' + err.message);
  }
});

// Upload endpoint
app.post('/upload', async (req, res) => {
  const { ticker, imageBase64 } = req.body;
  if (!ticker || !imageBase64) return res.status(400).send('Missing ticker or image');
  
  const imageBuffer = Buffer.from(imageBase64, 'base64');
  try {
    await pool.query(
      'INSERT INTO finviz_images (ticker, image) VALUES ($1, $2) ON CONFLICT (ticker) DO UPDATE SET image = $2, created_at = NOW()',
      [ticker, imageBuffer]
    );
    res.send('Image uploaded successfully');
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).send('Database error: ' + err.message);
  }
});

// Serve image endpoint
app.get('/image/:ticker', async (req, res) => {
  const { ticker } = req.params;
  try {
    const result = await pool.query('SELECT image FROM finviz_images WHERE ticker = $1', [ticker]);
    if (result.rows.length === 0) return res.status(404).send('Image not found');
    
    res.set('Content-Type', 'image/png');
    res.send(result.rows[0].image);
  } catch (err) {
    console.error('Image fetch error:', err);
    res.status(500).send('Database error: ' + err.message);
  }
});

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({
      status: 'ok',
      timestamp: result.rows[0].now,
      message: 'Database connection is working'
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      message: 'Database connection error: ' + err.message
    });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
}); 