// Dev-only static server. POST /shot?name=x with a PNG data URL saves shots/x.png
// (used to capture frames for side-by-side quality comparison). Not needed to run the app.
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const port = +process.argv[2] || 8770;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/shot') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      const name = (url.searchParams.get('name') || 'shot').replace(/[^\w.-]/g, '_');
      const dir = path.join(root, 'shots');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, name + '.png');
      fs.writeFileSync(file, Buffer.from(body.replace(/^data:image\/png;base64,/, ''), 'base64'));
      res.end(file);
    });
    return;
  }
  let p = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
  if (!p.startsWith(root)) { res.statusCode = 403; return res.end(); }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  fs.readFile(p, (err, data) => {
    if (err) { res.statusCode = 404; return res.end('not found'); }
    res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    // ?nopad hides any real controller from the page. A plugged-in pad steers the camera
    // and changes scenes, which silently ruins headless screenshot comparisons.
    if (url.searchParams.has('nopad') && path.extname(p) === '.html') {
      const stub = '<script>navigator.getGamepads = () => [];</script>';
      data = Buffer.from(String(data).replace('<script src="js/core.js">', stub + '<script src="js/core.js">'));
    }
    res.end(data);
  });
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}/`));
