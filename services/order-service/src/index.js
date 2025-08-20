const express = require('express');
const amqp = require('amqplib');
const Redis = require('ioredis');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

class OrderService {
  constructor() {
    this.app = express();
    this.rabbitmq = null;
    this.channel = null;
    this.redis = new Redis(process.env.REDIS_URL);
    this.pg = new Pool({
      connectionString: process.env.POSTGRES_URL,
      max: 10,
    });

    this.setupMiddleware();
    this.setupRoutes();
  }

  setupMiddleware() {
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    // Health check
    this.app.get('/health', (req, res) => {
      res.json({ 
        status: 'OK', 
        service: 'order-service',
        timestamp: new Date().toISOString() 
      });
    });
  }

  setupRoutes() {
    // Create new order
    this.app.post('/orders', async (req, res) => {
      try {
        const { userId, items, shippingAddress, paymentMethod } = req.body;
        
        // Validate required fields
        if (!userId || !items || items.length === 0) {
          return res.status(400).json({ error: 'Missing required fields' });
        }

        // Calculate totals
        const totalAmount = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
        const orderId = uuidv4();

        // Create order in database
        const order = await this.createOrder({
          orderId,
          userId,
          items,
          totalAmount,
          shippingAddress,
          paymentMethod,
          status: 'pending'
        });

        // Publish order created event
        await this.publishOrderEvent('orders.created', {
          orderId: order.id,
          userId: order.user_id,
          items: items,
          totalAmount: order.total_amount,
          currency: 'USD',
          timestamp: new Date().toISOString(),
          shippingAddress,
          paymentMethod
        });

        res.status(201).json({
          success: true,
          order: {
            id: order.id,
            orderId,
            status: order.status,
            totalAmount: order.total_amount,
            estimatedDelivery: this.calculateDeliveryDate()
          }
        });

      } catch (error) {
        console.error('Error creating order:', error);
        res.status(500).json({ error: 'Failed to create order' });
      }
    });

    // Get order by ID
    this.app.get('/orders/:orderId', async (req, res) => {
      try {
        const { orderId } = req.params;
        
        const result = await this.pg.query(`
          SELECT o.*, 
                 array_agg(
                   json_build_object(
                     'productId', oi.product_id,
                     'productName', oi.product_name,
                     'quantity', oi.quantity,
                     'unitPrice', oi.unit_price,
                     'totalPrice', oi.total_price
                   )
                 ) as items
          FROM orders o
          LEFT JOIN order_items oi ON o.id = oi.order_id
          WHERE o.order_id = $1
          GROUP BY o.id
        `, [orderId]);

        if (result.rows.length === 0) {
          return res.status(404).json({ error: 'Order not found' });
        }

        res.json({
          success: true,
          order: result.rows[0]
        });

      } catch (error) {
        console.error('Error fetching order:', error);
        res.status(500).json({ error: 'Failed to fetch order' });
      }
    });

    // Update order status
    this.app.patch('/orders/:orderId/status', async (req, res) => {
      try {
        const { orderId } = req.params;
        const { status, reason } = req.body;

        if (!['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'].includes(status)) {
          return res.status(400).json({ error: 'Invalid status' });
        }

        // Update order in database
        const result = await this.pg.query(`
          UPDATE orders 
          SET status = $1, updated_at = NOW()
          WHERE order_id = $2
          RETURNING *
        `, [status, orderId]);

        if (result.rows.length === 0) {
          return res.status(404).json({ error: 'Order not found' });
        }

        const order = result.rows[0];

        // Publish status update event
        const eventType = status === 'cancelled' ? 'orders.cancelled' : 'orders.updated';
        await this.publishOrderEvent(eventType, {
          orderId: order.id,
          userId: order.user_id,
          totalAmount: order.total_amount,
          currency: 'USD',
          status: order.status,
          previousStatus: 'pending', // In real app, track this
          reason,
          timestamp: new Date().toISOString()
        });

        // Update real-time cache
        await this.updateOrderMetrics(order, status);

        res.json({
          success: true,
          order: {
            id: order.id,
            status: order.status,
            updatedAt: order.updated_at
          }
        });

      } catch (error) {
        console.error('Error updating order status:', error);
        res.status(500).json({ error: 'Failed to update order status' });
      }
    });

    // Get user orders
    this.app.get('/users/:userId/orders', async (req, res) => {
      try {
        const { userId } = req.params;
        const { limit = 20, offset = 0, status } = req.query;

        let query = `
          SELECT o.*, 
                 COUNT(oi.id) as items_count
          FROM orders o
          LEFT JOIN order_items oi ON o.id = oi.order_id
          WHERE o.user_id = $1
        `;
        const params = [userId];

        if (status) {
          query += ` AND o.status = $${params.length + 1}`;
          params.push(status);
        }

        query += ` 
          GROUP BY o.id
          ORDER BY o.created_at DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `;
        params.push(limit, offset);

        const result = await this.pg.query(query, params);

        res.json({
          success: true,
          orders: result.rows,
          pagination: {
            limit: parseInt(limit),
            offset: parseInt(offset),
            hasMore: result.rows.length === parseInt(limit)
          }
        });

      } catch (error) {
        console.error('Error fetching user orders:', error);
        res.status(500).json({ error: 'Failed to fetch user orders' });
      }
    });

    // Order analytics endpoint
    this.app.get('/analytics/orders', async (req, res) => {
      try {
        const { period = 'daily' } = req.query;
        const today = new Date().toISOString().split('T')[0];

        const analytics = {};

        if (period === 'daily') {
          // Get today's metrics from Redis
          const [total, completed, cancelled, pending] = await Promise.all([
            this.redis.get(`orders:count:${today}`) || 0,
            this.redis.get(`orders:completed:${today}`) || 0,
            this.redis.get(`orders:cancelled:${today}`) || 0,
            this.redis.get(`orders:pending:${today}`) || 0
          ]);

          analytics.today = {
            total: parseInt(total),
            completed: parseInt(completed),
            cancelled: parseInt(cancelled),
            pending: parseInt(pending),
            conversionRate: total > 0 ? ((completed / total) * 100).toFixed(2) : 0
          };
        }

        // Get historical data from database
        const historyQuery = `
          SELECT 
            DATE(created_at) as date,
            COUNT(*) as total_orders,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
            SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
            SUM(total_amount) as revenue
          FROM orders
          WHERE created_at >= NOW() - INTERVAL '30 days'
          GROUP BY DATE(created_at)
          ORDER BY date DESC
          LIMIT 30
        `;

        const historyResult = await this.pg.query(historyQuery);
        analytics.history = historyResult.rows;

        res.json({
          success: true,
          analytics,
          lastUpdated: new Date().toISOString()
        });

      } catch (error) {
        console.error('Error fetching order analytics:', error);
        res.status(500).json({ error: 'Failed to fetch analytics' });
      }
    });
  }

  async createOrder(orderData) {
    const client = await this.pg.connect();
    
    try {
      await client.query('BEGIN');

      // Insert order
      const orderResult = await client.query(`
        INSERT INTO orders (order_id, user_id, total_amount, status, created_at)
        VALUES ($1, $2, $3, $4, NOW())
        RETURNING *
      `, [orderData.orderId, orderData.userId, orderData.totalAmount, orderData.status]);

      const order = orderResult.rows[0];

      // Insert order items
      for (const item of orderData.items) {
        await client.query(`
          INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, total_price)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [
          order.id,
          item.productId || `product_${Math.floor(Math.random() * 1000)}`,
          item.productName || `Product ${item.productId}`,
          item.quantity,
          item.price,
          item.price * item.quantity
        ]);
      }

      await client.query('COMMIT');
      return order;

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async publishOrderEvent(eventType, data) {
    if (!this.channel) return;

    try {
      const message = Buffer.from(JSON.stringify(data));
      await this.channel.publish('orders.events', eventType, message, {
        persistent: true,
        timestamp: Date.now()
      });

      console.log(`Published event: ${eventType} for order ${data.orderId}`);

    } catch (error) {
      console.error('Error publishing order event:', error);
    }
  }

  async updateOrderMetrics(order, status) {
    const today = new Date().toISOString().split('T')[0];

    try {
      // Update status-specific counters
      await this.redis.incr(`orders:${status}:${today}`);
      
      // Update total order count
      await this.redis.incr(`orders:count:${today}`);

      // Update user activity
      await this.redis.sadd(`users:active:${today}`, order.user_id);

      console.log(`Updated metrics for order ${order.id} - status: ${status}`);

    } catch (error) {
      console.error('Error updating order metrics:', error);
    }
  }

  calculateDeliveryDate() {
    const deliveryDate = new Date();
    deliveryDate.setDate(deliveryDate.getDate() + Math.floor(Math.random() * 7) + 1);
    return deliveryDate.toISOString().split('T')[0];
  }

  async connectRabbitMQ() {
    try {
      const connection = await amqp.connect(process.env.RABBITMQ_URL);
      this.channel = await connection.createChannel();

      // Declare exchange
      await this.channel.assertExchange('orders.events', 'topic', { durable: true });

      console.log('Order Service connected to RabbitMQ');

    } catch (error) {
      console.error('Failed to connect to RabbitMQ:', error);
    }
  }

  async initialize() {
    await this.connectRabbitMQ();
    
    const port = process.env.ORDER_SERVICE_PORT || 3002;
    this.app.listen(port, () => {
      console.log(`Order Service running on port ${port}`);
    });
  }
}

// Initialize service
const orderService = new OrderService();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down Order Service...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Shutting down Order Service...');
  process.exit(0);
});

// Start the service
orderService.initialize();