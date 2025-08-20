const errorHandler = (err, req, res, next) => {
    console.error('Error:', err.stack);
  
    // Default error
    let error = {
      message: err.message || 'Internal Server Error',
      status: err.statusCode || 500
    };
  
    if (err.name === 'CastError') {
      error.message = 'Resource not found';
      error.status = 404;
    }
  
    if (err.code === 11000) {
      error.message = 'Duplicate field value entered';
      error.status = 400;
    }
  
    if (err.name === 'ValidationError') {
      error.message = Object.values(err.errors).map(val => val.message).join(', ');
      error.status = 400;
    }
  
    if (err.name === 'JsonWebTokenError') {
      error.message = 'Invalid token';
      error.status = 401;
    }
  
    if (err.name === 'TokenExpiredError') {
      error.message = 'Token expired';
      error.status = 401;
    }
  
    if (err.code === 'ECONNREFUSED' && err.port === 6379) {
      error.message = 'Cache service unavailable';
      error.status = 503;
    }
  
    // PostgreSQL errors
    if (err.code === '23505') { // unique_violation
      error.message = 'Duplicate entry';
      error.status = 409;
    }
  
    if (err.code === '23503') { // foreign_key_violation
      error.message = 'Referenced resource not found';
      error.status = 400;
    }
  
    // RabbitMQ errors
    if (err.message && err.message.includes('AMQP')) {
      error.message = 'Message queue service unavailable';
      error.status = 503;
    }
  
    // Rate limiting errors
    if (err.message === 'Too many requests') {
      error.status = 429;
    }
  
    res.status(error.status).json({
      success: false,
      error: error.message,
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
      timestamp: new Date().toISOString(),
      path: req.path
    });
  };
  
module.exports = errorHandler;