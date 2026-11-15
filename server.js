'use strict';
// Local dev: serves public/ + the API on http://localhost:3000
const path = require('path');
const express = require('express');
const app = require('./app');

const root = express();
root.use(app);
root.use(express.static(path.join(__dirname, 'public')));
const port = process.env.PORT || 3000;
root.listen(port, () => console.log(`ChemStep running on http://localhost:${port}`));
