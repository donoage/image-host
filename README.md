# Finviz Chart Image Host

A service for downloading, processing, and hosting Finviz stock charts in a PostgreSQL database.

## Features

- Download stock charts from Finviz
- Store images in PostgreSQL database
- Retrieve images by stock symbol
- Batch processing for multiple symbols

## API Endpoints

### Download and Store a Chart
```
POST /charts
Content-Type: application/json

{
  "symbol": "AAPL"
}
```

### Get a Chart by Symbol
```
GET /charts/AAPL
```

### Get All Available Symbols
```
GET /symbols
```

### Batch Process Multiple Symbols
```
POST /batch-charts
Content-Type: application/json

{
  "symbols": ["AAPL", "MSFT", "GOOG"]
}
```

## Integration with moe-bot

This service is designed to integrate with `/Users/stephenbae/Projects/moe-bot/shared/update-notion-tables.js`.

### Example Usage from Node.js

```javascript
// In your moe-bot script
const axios = require('axios');

// Base URL of the deployed service (Railway)
const IMAGE_HOST_URL = process.env.IMAGE_HOST_URL || 'https://your-railway-app.railway.app';

async function getStockChart(symbol) {
  try {
    // First check if the image already exists
    const response = await axios.get(`${IMAGE_HOST_URL}/charts/${symbol}`, {
      responseType: 'arraybuffer'
    });
    
    return response.data;
  } catch (error) {
    if (error.response && error.response.status === 404) {
      // Image doesn't exist, request to generate it
      await axios.post(`${IMAGE_HOST_URL}/charts`, { symbol });
      
      // Now try to get it again
      const response = await axios.get(`${IMAGE_HOST_URL}/charts/${symbol}`, {
        responseType: 'arraybuffer'
      });
      
      return response.data;
    }
    
    throw error;
  }
}

// Then you can use it in your update-notion-tables.js script
// Example: const chartBuffer = await getStockChart('AAPL');
```

## Deployment on Railway

1. Create a new project on Railway
2. Connect your GitHub repository
3. Add a PostgreSQL database to your project
4. Set environment variables:
   - `NODE_ENV=production`
   - `DATABASE_URL` will be automatically set by Railway
   - `PORT` will be automatically set by Railway

## Development

1. Clone the repository
2. Install dependencies: `npm install`
3. Create a `.env` file with your PostgreSQL connection string
4. Run the server: `npm start` 