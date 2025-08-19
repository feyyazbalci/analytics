const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { createServer } = require('http');
const { Server } = require('socket.io');
const Redis = require('ioredis');
const amqp = require('amqplib');

// Routes
const analyticsRoutes = require('./routes/analytics');
const orderRoutes = require('./routes/orders');
const authRoutes = require('./routes/auth');

// Middleware
const authMiddleware = require('./middleware/auth');
const errorHandler = require('./middleware/errorHandler');

class ApiGateway {
  constructor() {
    this.app = express();
    this.server = createServer(this.app);
    this.io = new Server(this.server, {
      cors: {
        origin: process.env.FRONTEND_URL || "http://localhost:3001",
        methods: ["GET", "POST"]
      }
    });
    
    this.redis = null;
    this.rabbitmq = null;
    this.channel = null;
    
    this.setupMiddleware();
    this.setupRoutes();
    this.setupSocketIO();
    this.setupErrorHandling();
  }

  setupMiddleware() {
    // Security
    this.app.use(helmet());
    this.app.use(cors({
      origin: process.env.FRONTEND_URL || "http://localhost:3001",
      credentials: true
    }));

    // Rate limiting
    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 100 // limit each IP to 100 requests per windowMs
    });
    this.app.use('/api/', limiter);

    // Logging
    this.app.use(morgan('combined'));
    
    // Body parsing
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));

    // Health check
    this.app.get('/health', (req, res) => {
      res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        services: {
          redis: this.redis?.status === 'ready',
          rabbitmq: !!this.channel
        }
      });
    });
  }

  setupRoutes() {
    // Public routes
    this.app.use('/api/auth', authRoutes);
    
    // Protected routes
    this.app.use('/api/analytics', authMiddleware, analyticsRoutes);
    this.app.use('/api/orders', authMiddleware, orderRoutes);

    // API Documentation
    this.app.get('/api', (req, res) => {
      res.json({
        name: 'E-commerce Analytics API',
        version: '1.0.0',
        endpoints: {
          auth: '/api/auth',
          analytics: '/api/analytics',
          orders: '/api/orders'
        },
        realtime: '/socket.io',
        documentation: '/api/docs'
      });
    });
  }

  setupSocketIO() {
    this.io.use((socket, next) => {
      // Socket authentication middleware
      const token = socket.handshake.auth.token;
      if (token) {
        // Verify JWT token here
        next();
      } else {
        next(new Error('Authentication error'));
      }
    });

    this.io.on('connection', (socket) => {
      console.log(`Client connected: ${socket.id}`);
      
      socket.on('subscribe_analytics', (room) => {
        socket.join(`analytics_${room}`);
        console.log(`Client ${socket.id} subscribed to analytics_${room}`);
      });

      socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
      });
    });

    // Make io available globally
    this.app.set('io', this.io);
  }

  setupErrorHandling() {
    this.app.use(errorHandler);
  }

  async connectRedis() {
    try {
      this.redis = new Redis(process.env.REDIS_URL);
      
      this.redis.on('connect', () => {
        console.log('✅ Connected to Redis');
      });

      this.redis.on('error', (err) => {
        console.error('❌ Redis connection error:', err);
      });

      // Make redis available to routes
      this.app.set('redis', this.redis);
      
    } catch (error) {
      console.error('❌ Failed to connect to Redis:', error);
    }
  }

  async connectRabbitMQ() {
    try {
      const connection = await amqp.connect(process.env.RABBITMQ_URL);
      this.channel = await connection.createChannel();
      
      // Declare exchanges
      await this.channel.assertExchange('analytics.events', 'topic', { durable: true });
      await this.channel.assertExchange('orders.events', 'topic', { durable: true });
      await this.channel.assertExchange('notifications.events', 'topic', { durable: true });

      console.log('✅ Connected to RabbitMQ');

      // Make channel available to routes
      this.app.set('rabbitmq', this.channel);

      // Listen for analytics events to broadcast via WebSocket
      this.listenToAnalyticsEvents();
      
    } catch (error) {
      console.error('❌ Failed to connect to RabbitMQ:', error);
    }
  }

  async listenToAnalyticsEvents() {
    if (!this.channel) return;

    // Create queue for real-time updates
    const queue = await this.channel.assertQueue('gateway.analytics.updates', { durable: false });
    
    await this.channel.bindQueue(queue.queue, 'analytics.events', 'analytics.updated.*');
    
    this.channel.consume(queue.queue, (msg) => {
      if (msg) {
        const event = JSON.parse(msg.content.toString());
        const routingKey = msg.fields.routingKey;
        
        // Broadcast to connected clients
        const room = routingKey.split('.')[2]; // analytics.updated.revenue -> revenue
        this.io.to(`analytics_${room}`).emit('analytics_update', event);
        
        this.channel.ack(msg);
      }
    });
  }

  async initialize() {
    await this.connectRedis();
    await this.connectRabbitMQ();
    
    const port = process.env.PORT || 3000;
    this.server.listen(port, () => {
      console.log(`🚀 API Gateway running on port ${port}`);
      console.log(`📊 Socket.IO server ready for real-time updates`);
    });
  }
}

module.exports = ApiGateway;