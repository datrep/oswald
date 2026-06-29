const sql = require('mssql');

// Custom error classes (you can move these to utils/errors.js)
class AppError extends Error {
    constructor(message, statusCode) {
        super(message);
        this.name = this.constructor.name;
        this.statusCode = statusCode;
        Error.captureStackTrace(this, this.constructor);
    }
}

class NotFoundError extends AppError {
    constructor(message = 'Resource not found') {
        super(message, 404);
    }
}

class ValidationError extends AppError {
    constructor(message = 'Validation failed') {
        super(message, 400);
    }
}

class UnauthorizedError extends AppError {
    constructor(message = 'Unauthorized') {
        super(message, 401);
    }
}

class ForbiddenError extends AppError {
    constructor(message = 'Forbidden') {
        super(message, 403);
    }
}

// Global error handler
function globalErrorHandler(err, req, res, next) {
    // Log the error with stack trace for debugging
    console.error(`[${new Date().toISOString()}] Error:`, err);
    
    // If headers already sent, delegate to Express
    if (res.headersSent) {
        return next(err);
    }
    
    // Handle our custom AppErrors (404, 400, 401, 403, etc.)
    if (err instanceof AppError) {
        return res.status(err.statusCode).json({ 
            error: err.message,
            // Only include stack in development
            ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
        });
    }
    
    // Handle database errors
    if (err instanceof sql.RequestError) {
        return res.status(500).json({ 
            error: "Database Error",
            details: err.message,
            ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
        });
    }
    
    // Handle Joi validation errors (if you're using Joi)
    if (err.isJoi) {
        return res.status(400).json({
            error: 'Validation Error',
            details: err.details.map(d => d.message)
        });
    }
    
    // Handle everything else as 500
    const statusCode = err.statusCode || 500;
    const message = statusCode === 500 ? 'Internal Server Error' : err.message;
    
    res.status(statusCode).json({
        error: message,
        ...(process.env.NODE_ENV === 'development' && { 
            details: err.message,
            stack: err.stack 
        })
    });
}

// 404 handler for unmatched routes
function notFoundHandler(req, res, next) {
    res.status(404).json({ 
        error: `Route ${req.method} ${req.originalUrl} not found` 
    });
}

// Unhandled rejection handler
function unhandledRejectionHandler(reason, promise) {
    console.error("Unhandled Rejection at:", promise);
    console.error("Unhandled Rejection reason:", reason);
    // In production, you might want to log this and restart gracefully
    process.exit(1);
}

module.exports = {
    globalErrorHandler,
    notFoundHandler,
    unhandledRejectionHandler,
    // Export custom errors so controllers can use them
    AppError,
    NotFoundError,
    ValidationError,
    UnauthorizedError,
    ForbiddenError
};
