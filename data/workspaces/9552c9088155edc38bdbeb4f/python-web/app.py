
import json, os
from http.server import BaseHTTPRequestHandler, HTTPServer

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/api/info':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'ok': True, 'runtime': 'python3'}).encode())
            return
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.end_headers()
        self.wfile.write(b'<h1>Python App Live</h1>')
    def log_message(self, format, *args):
        pass

port = int(os.environ.get('PORT', '8000'))
HTTPServer(('127.0.0.1', port), Handler).serve_forever()
