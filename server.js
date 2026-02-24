const express = require('express');
const app = express();
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'FinFamily Scraper', timestamp: new Date().toISOString() });
});
app.get('/', (req, res) => { res.json({ hello: 'world' }); });
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => { console.log('Server running on port ' + PORT); });
