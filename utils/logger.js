
// Simple request logging middleware


function logall(req, res, next) {
  const start = Date.now();

  res.on("finish", () => {
    const duration = Date.now() - start;
    if ((req.originalUrl === "/api/ip/check") && (res.statusCode === 200)) { // nuke all /api/ip/check logs, PLEASE CHANGE THIS LATER //TODO://
      //skip
    } else {
       console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
    }
  });

  next();
}

module.exports = logall;