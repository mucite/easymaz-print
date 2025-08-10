const express = require('express');
const bodyParser = require('body-parser');
const printReceipt = require('./print-helper');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON bodies
app.use(bodyParser.json());

// Print endpoint
app.post('/print', async (req, res) => {
  const data = req.body;
  try {
    await printReceipt(data);
    res.json({ success: true, message: 'Receipt printed successfully' });
  } catch (error) {
    console.error('Print error:', error);
    res.status(500).json({ success: false, message: 'Failed to print receipt', error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Print API listening on port ${PORT}`);
});
