// global error handler, prevent default rejection res
function globalErrorHandler(err, req, res, next) {
  console.error("Global Error Handler:", err);
    if (res.headersSent) {
    return next(err);
    }
    if (err instanceof sql.RequestError) {
        res.status(500).json({ error: "Database Error", details: err.message });
    } else {
        res.status(500).json({ error: "Internal Server Error" });
    }
}

// 500 handler for global unhandled rejections
function unhandledRejectionHandler(reason, promise) {
  console.error("Unhandled Rejection at:", promise);

    // log
    console.error("Unhandled Rejection:", reason);
    process.exit(1);
};


// 404 handler
function notFoundHandler(req, res, next) {
  res.status(404).json({
    error: "Not Found"
  });
}



module.exports = {
    globalErrorHandler,
    notFoundHandler,
    unhandledRejectionHandler
};
