/* eslint-disable */
// A09 FAULT INJECTION: deliberately unsafe code so that Semgrep must flag it (severity ERROR).
const express = require('express');
const app = express();
app.get('/run', (req, res) => {
  res.send(eval(req.query.code));
});
