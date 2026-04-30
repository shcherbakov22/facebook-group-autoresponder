#!/usr/bin/env node

const http = require('node:http');

const port = Number(process.env.FB_BOT_PORT || 4020);

http.get(`http://127.0.0.1:${port}/status`, (res) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8');
    process.stdout.write(text);
    if (res.statusCode < 200 || res.statusCode >= 300) process.exit(1);
  });
}).on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
