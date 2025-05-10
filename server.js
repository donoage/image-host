// Simple Express server to fix the 'no start command could be found' error on Railway
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

// Basic route to show the server is running
app.get('/', (req, res) => {
  res.send('Image Host Server is running');
});

// Start the server
app.listen(port, () => { console.log(`Server running on port ${port}`); });
