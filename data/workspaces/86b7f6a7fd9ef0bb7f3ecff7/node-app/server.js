
      const http = require('http');
      const port = process.env.PORT || 3000;
      const server = http.createServer((req, res) => {
        if (req.url === '/api/ping') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, runtime: 'nodejs' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Node App Live</h1>');
      });
      server.listen(port, '127.0.0.1');
    