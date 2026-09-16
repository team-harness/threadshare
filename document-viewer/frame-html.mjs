export const FLOWCHART_FRAME_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Flowchart</title>
    <script src="/flowchart-frame.js" defer></script>
  </head>
  <body></body>
</html>`;

export const FLOWCHART_FRAME_CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
