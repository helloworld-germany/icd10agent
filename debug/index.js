'use strict';

const path = require('path');
const fs = require('fs');
const { html, serverError } = require('../shared/http');

module.exports = async function (context, req) {
  try {
    const file = path.join(__dirname, 'debug.html');
    const body = fs.readFileSync(file, 'utf8');
    html(context, 200, body);
  } catch (err) {
    serverError(context, err);
  }
};
