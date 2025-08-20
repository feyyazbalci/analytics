const amqp = require('amqplib');
const Redis = require('ioredis');
const nodemailer = require('nodemailer');

class NotificationService {
  constructor() {
    this.rabbitmq = null;
    this.channel = null;
    this.redis = new Redis(process.env.REDIS_URL);
    
    // Email transporter (using fake SMTP for demo)
    this.emailTransporter = nodemailer.createTransporter({
      host: 'smtp.ethereal.email',
      port: 587,
      auth: {
        user: 'ethereal.user@ethereal.email',
        pass: 'ethereal.pass'
      }
    });

    this.notificationRules = {
      'orders.created': {
        type: 'order_confirmation',
        priority: 'high',
        channels: ['email', 'push', 'dashboard']
      },
      'orders.cancelled': {
        type: 'order_cancelled',
        priority: 'high',
        channels: ['email', 'dashboard']
      },
      'analytics.updated.revenue': {
        type: 'revenue_milestone',
        priority: 'medium',
        channels: ['dashboard', 'slack']
      },
      'inventory.low_stock': {
        type: 'stock_alert',
        priority: 'high',
        channels: ['email', 'dashboard', 'slack']
      }
    };
  }

  async initialize() {
    try {
      await this.connectRabbitMQ();
      await this.setupQueues();
      await this.startConsumers();
      
      console.log('Notification Service initialized successfully');
    } catch (error) {
      console.error('Failed to initialize Notification Service:', error);
      process.exit(1);
    }
  }

  async connectRabbitMQ() {
    const connection = await amqp.connect(process.env.RABBITMQ_URL);
    this.channel = await connection.createChannel();
    await this.channel.prefetch(5); // Process 5 notifications at once
    
    console.log('✅ Notification Service connected to RabbitMQ');
  }

  async setupQueues() {
    // Declare exchanges
    await this.channel.assertExchange('orders.events', 'topic', { durable: true });
    await this.channel.assertExchange('analytics.events', 'topic', { durable: true });
    await this.channel.assertExchange('notifications.events', 'topic', { durable: true });

    // Declare notification queues
    const queues = [
      {
        name: 'notifications.orders',
        routingKeys: ['orders.created', 'orders.cancelled', 'orders.updated'],
        exchange: 'orders.events'
      },
      {
        name: 'notifications.analytics',
        routingKeys: ['analytics.updated.*', 'analytics.milestone.*'],
        exchange: 'analytics.events'
      },
      {
        name: 'notifications.alerts',
        routingKeys: ['inventory.low_stock', 'system.alert.*'],
        exchange: 'notifications.events'
      }
    ];

    for (const queueConfig of queues) {
      const queue = await this.channel.assertQueue(queueConfig.name, {
        durable: true,
        arguments: {
          'x-dead-letter-exchange': 'notifications.dlx',
          'x-message-ttl': 3600000 // 1 hour TTL
        }
      });

      // Bind routing keys
      for (const routingKey of queueConfig.routingKeys) {
        await this.channel.bindQueue(queue.queue, queueConfig.exchange, routingKey);
      }
    }

    // Dead letter setup
    await this.channel.assertExchange('notifications.dlx', 'direct', { durable: true });
    await this.channel.assertQueue('notifications.failed', { durable: true });
    await this.channel.bindQueue('notifications.failed', 'notifications.dlx', '');
  }

  async startConsumers() {
    // Order notifications consumer
    await this.channel.consume('notifications.orders', async (msg) => {
      if (msg) {
        try {
          const event = JSON.parse(msg.content.toString());
          const routingKey = msg.fields.routingKey;
          
          console.log(`Processing order notification: ${routingKey}`);
          await this.handleOrderNotification(event, routingKey);
          
          this.channel.ack(msg);
          
        } catch (error) {
          console.error('Error processing order notification:', error);
          this.channel.nack(msg, false, false);
        }
      }
    });

    // Analytics notifications consumer
    await this.channel.consume('notifications.analytics', async (msg) => {
      if (msg) {
        try {
          const event = JSON.parse(msg.content.toString());
          const routingKey = msg.fields.routingKey;
          
          console.log(`Processing analytics notification: ${routingKey}`);
          await this.handleAnalyticsNotification(event, routingKey);
          
          this.channel.ack(msg);
          
        } catch (error) {
          console.error('Error processing analytics notification:', error);
          this.channel.nack(msg, false, false);
        }
      }
    });

    // Alert notifications consumer
    await this.channel.consume('notifications.alerts', async (msg) => {
      if (msg) {
        try {
          const event = JSON.parse(msg.content.toString());
          const routingKey = msg.fields.routingKey;
          
          console.log(`Processing alert notification: ${routingKey}`);
          await this.handleAlertNotification(event, routingKey);
          
          this.channel.ack(msg);
          
        } catch (error) {
          console.error('Error processing alert notification:', error);
          this.channel.nack(msg, false, false);
        }
      }
    });

    console.log('🎯 All notification consumers started');
  }

  async handleOrderNotification(event, routingKey) {
    const rule = this.notificationRules[routingKey];
    if (!rule) return;

    const notification = {
      id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: rule.type,
      priority: rule.priority,
      data: event,
      timestamp: new Date().toISOString(),
      channels: rule.channels
    };

    // Send through different channels
    for (const channel of rule.channels) {
      switch (channel) {
        case 'email':
          await this.sendEmailNotification(notification);
          break;
        case 'push':
          await this.sendPushNotification(notification);
          break;
        case 'dashboard':
          await this.sendDashboardNotification(notification);
          break;
        case 'slack':
          await this.sendSlackNotification(notification);
          break;
      }
    }

    // Store notification in Redis for history
    await this.storeNotification(notification);
  }

  async handleAnalyticsNotification(event, routingKey) {
    // Check for milestone achievements
    if (routingKey.includes('revenue')) {
      await this.checkRevenueMilestones(event);
    }
    
    if (routingKey.includes('orders')) {
      await this.checkOrderMilestones(event);
    }

    // Real-time dashboard updates are handled by API Gateway
    // We can add additional processing here if needed
  }

  async handleAlertNotification(event, routingKey) {
    const notification = {
      id: `alert_${Date.now()}`,
      type: 'system_alert',
      priority: 'high',
      data: event,
      timestamp: new Date().toISOString(),
      channels: ['dashboard', 'email', 'slack']
    };

    // Send critical alerts immediately
    await this.sendDashboardNotification(notification);
    await this.sendSlackNotification(notification);
    
    if (event.severity === 'critical') {
      await this.sendEmailNotification(notification);
    }
  }

  async sendEmailNotification(notification) {
    try {
      let subject, html;

      switch (notification.type) {
        case 'order_confirmation':
          subject = `Order Confirmation #${notification.data.orderId}`;
          html = this.generateOrderConfirmationEmail(notification.data);
          break;
        case 'order_cancelled':
          subject = `Order Cancelled #${notification.data.orderId}`;
          html = this.generateOrderCancelledEmail(notification.data);
          break;
        case 'stock_alert':
          subject = 'Low Stock Alert';
          html = this.generateStockAlertEmail(notification.data);
          break;
        default:
          subject = 'Notification from E-commerce Platform';
          html = `<p>Event: ${notification.type}</p><pre>${JSON.stringify(notification.data, null, 2)}</pre>`;
      }

      // hard coded email but i can change later.
      const userEmail = 'user@example.com';
      
      const mailOptions = {
        from: '"E-commerce Platform" <noreply@ecommerce.com>',
        to: userEmail,
        subject,
        html
      };

      await this.emailTransporter.sendMail(mailOptions);
      console.log(`Email sent: ${subject}`);

    } catch (error) {
      console.error('Error sending email:', error);
    }
  }

  async sendPushNotification(notification) {
    try {
      // In production, integrate with Firebase Cloud Messaging or similar
      const pushPayload = {
        title: this.getPushTitle(notification),
        body: this.getPushBody(notification),
        data: notification.data,
        timestamp: notification.timestamp
      };

      // Store for web push or mobile push
      await this.redis.lpush('push_notifications', JSON.stringify(pushPayload));
      await this.redis.ltrim('push_notifications', 0, 99); // Keep last 100

      console.log(`Push notification queued: ${pushPayload.title}`);

    } catch (error) {
      console.error('Error sending push notification:', error);
    }
  }

  async sendDashboardNotification(notification) {
    try {
      // Store in Redis for real-time dashboard updates
      const dashboardNotif = {
        id: notification.id,
        type: notification.type,
        message: this.getDashboardMessage(notification),
        priority: notification.priority,
        data: notification.data,
        timestamp: notification.timestamp,
        read: false
      };

      await this.redis.lpush('dashboard_notifications', JSON.stringify(dashboardNotif));
      await this.redis.ltrim('dashboard_notifications', 0, 49); // Keep last 50
      await this.redis.expire('dashboard_notifications', 86400); // 24 hours

      // Publish to real-time channel
      await this.redis.publish('dashboard_updates', JSON.stringify({
        type: 'notification',
        data: dashboardNotif
      }));

      console.log(`Dashboard notification sent: ${dashboardNotif.message}`);

    } catch (error) {
      console.error('Error sending dashboard notification:', error);
    }
  }

  async sendSlackNotification(notification) {
    try {
      // In production, integrate with Slack webhooks
      const slackMessage = {
        text: this.getSlackMessage(notification),
        channel: '#alerts',
        username: 'E-commerce Bot',
        icon_emoji: ':shopping_cart:',
        attachments: [{
          color: this.getSlackColor(notification.priority),
          fields: [{
            title: 'Details',
            value: JSON.stringify(notification.data, null, 2),
            short: false
          }],
          ts: Math.floor(Date.now() / 1000)
        }]
      };

      // Store for webhook processing
      await this.redis.lpush('slack_notifications', JSON.stringify(slackMessage));

      console.log(`Slack notification queued: ${slackMessage.text}`);

    } catch (error) {
      console.error('Error sending Slack notification:', error);
    }
  }

  async storeNotification(notification) {
    try {
      // Store in Redis with expiration
      const key = `notification:${notification.id}`;
      await this.redis.setex(key, 86400 * 7, JSON.stringify(notification)); // 7 days

      // Add to user's notification list
      const userKey = `user:${notification.data.userId}:notifications`;
      await this.redis.lpush(userKey, notification.id);
      await this.redis.ltrim(userKey, 0, 99); // Keep last 100 per user

      console.log(`Stored notification: ${notification.id}`);

    } catch (error) {
      console.error('Error storing notification:', error);
    }
  }

  async checkRevenueMilestones(event) {
    // Check if we hit revenue milestones
    const dailyRevenue = event.data?.dailyRevenue || 0;
    const milestones = [1000, 5000, 10000, 25000, 50000, 100000];

    for (const milestone of milestones) {
      const key = `milestone:revenue:daily:${milestone}`;
      const alreadyHit = await this.redis.get(key);

      if (!alreadyHit && dailyRevenue >= milestone) {
        await this.redis.setex(key, 86400, 'true'); // Set for 24 hours

        // Publish milestone achievement
        await this.channel.publish('notifications.events', 'revenue.milestone.achieved', 
          Buffer.from(JSON.stringify({
            type: 'revenue_milestone',
            milestone,
            currentRevenue: dailyRevenue,
            timestamp: new Date().toISOString()
          })),
          { persistent: true }
        );
      }
    }
  }

  // Helper methods for message formatting
  generateOrderConfirmationEmail(data) {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2563eb;">Order Confirmation</h2>
        <p>Thank you for your order!</p>
        <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h3>Order Details</h3>
          <p><strong>Order ID:</strong> ${data.orderId}</p>
          <p><strong>Total Amount:</strong> $${data.totalAmount}</p>
          <p><strong>Items:</strong> ${data.items?.length || 0}</p>
        </div>
        <p>We'll send you updates as your order progresses.</p>
      </div>
    `;
  }

  getPushTitle(notification) {
    switch (notification.type) {
      case 'order_confirmation':
        return 'Order Confirmed!';
      case 'order_cancelled':
        return 'Order Cancelled';
      case 'stock_alert':
        return 'Stock Alert';
      default:
        return 'Notification';
    }
  }

  getPushBody(notification) {
    switch (notification.type) {
      case 'order_confirmation':
        return `Your order #${notification.data.orderId} has been confirmed`;
      case 'order_cancelled':
        return `Order #${notification.data.orderId} has been cancelled`;
      default:
        return 'You have a new notification';
    }
  }

  getDashboardMessage(notification) {
    switch (notification.type) {
      case 'order_confirmation':
        return `New order received: #${notification.data.orderId} ($${notification.data.totalAmount})`;
      case 'order_cancelled':
        return `Order cancelled: #${notification.data.orderId}`;
      case 'revenue_milestone':
        return `Revenue milestone reached: $${notification.data.milestone}`;
      case 'stock_alert':
        return `Low stock alert: ${notification.data.productName}`;
      default:
        return `System notification: ${notification.type}`;
    }
  }

  getSlackMessage(notification) {
    return `🔔 ${this.getDashboardMessage(notification)}`;
  }

  getSlackColor(priority) {
    switch (priority) {
      case 'high': return 'danger';
      case 'medium': return 'warning';
      case 'low': return 'good';
      default: return 'good';
    }
  }

  async gracefulShutdown() {
    console.log('Shutting down Notification Service...');
    
    if (this.channel) {
      await this.channel.close();
    }
    
    if (this.redis) {
      this.redis.disconnect();
    }
    
    process.exit(0);
  }
}

const notificationService = new NotificationService();

// Graceful shutdown
process.on('SIGTERM', () => notificationService.gracefulShutdown());
process.on('SIGINT', () => notificationService.gracefulShutdown());

// Start the service
notificationService.initialize();
