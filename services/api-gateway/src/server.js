require('dotenv').config();
const ApiGateway = require('./app');

// Create and initialize API Gateway
const gateway = new ApiGateway();

// Start the gateway
gateway.initialize().catch((error) => {
    console.error('Failed to start API Gateway:', error);
    process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    process.exit(1);
});
  
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});