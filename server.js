require('dotenv').config();
const express = require('express');
const printReceipt = require('./helper');
const winston = require('winston');

const app = express();
const PORT = process.env.PORT || 3001;

// Logger
const logger = winston.createLogger({
    level: 'info',
    transports: [
        new winston.transports.Console({
            format: winston.format.simple()
        })
    ]
});

// Middleware
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', service: 'easymaz-printer-bridge' });
});

// Test print endpoint
app.post('/test-print', async (req, res) => {
    try {
        logger.info('📥 Received test print request');

        const { printerOptions } = req.body || {};

        // Merge printer options from environment and request
        const options = {
            type: printerOptions?.type || process.env.PRINTER_TYPE || 'usb',
            ip: printerOptions?.ip || process.env.PRINTER_IP,
            port: printerOptions?.port || process.env.PRINTER_PORT || 9100,
            vendorId: printerOptions?.vendorId,
            productId: printerOptions?.productId,
            address: printerOptions?.address || process.env.PRINTER_BT_ADDRESS
        };

        // Create test print data
        const testPrintData = {
            restaurant: {
                name: 'EasyMaz Test',
                phone: '+251 911 234 567',
                address: 'Test Location'
            },
            orderNumber: 'TEST-001',
            orderDate: new Date().toLocaleString(),
            items: [
                {
                    name: 'Test Item 1',
                    quantity: 1,
                    price: 100,
                    total: 100
                },
                {
                    name: 'Test Item 2',
                    quantity: 2,
                    price: 50,
                    total: 100
                }
            ],
            subtotal: 200,
            tax: 0,
            total: 200,
            paymentMethod: 'Cash'
        };

        logger.info(`🖨️ Testing printer: ${options.type}`);

        // Call the print function
        await printReceipt(testPrintData, options);

        logger.info('✅ Test print completed successfully');

        res.status(200).json({
            success: true,
            message: 'Test print completed',
            printerType: options.type,
            printerConfig: {
                type: options.type,
                ip: options.ip,
                port: options.port
            }
        });

    } catch (error) {
        logger.error('❌ Test print failed:', error);

        res.status(500).json({
            success: false,
            error: error.message || 'Test print failed',
            details: error.stack
        });
    }
});

// Print endpoint
app.post('/print', async (req, res) => {
    try {
        logger.info('📥 Received print request');

        const { printData, printerOptions } = req.body;

        if (!printData) {
            return res.status(400).json({
                success: false,
                error: 'No print data provided'
            });
        }

        // Merge printer options from environment and request
        const options = {
            type: printerOptions?.type || process.env.PRINTER_TYPE || 'usb',
            ip: printerOptions?.ip || process.env.PRINTER_IP,
            port: printerOptions?.port || process.env.PRINTER_PORT || 9100,
            vendorId: printerOptions?.vendorId,
            productId: printerOptions?.productId,
            address: printerOptions?.address || process.env.PRINTER_BT_ADDRESS
        };

        logger.info(`🖨️ Using printer: ${options.type}`);

        // Call the existing print function with options
        await printReceipt(printData, options);

        logger.info('✅ Print job completed successfully');

        res.status(200).json({
            success: true,
            message: 'Print job completed',
            printerType: options.type
        });

    } catch (error) {
        logger.error('❌ Print job failed:', error);

        res.status(500).json({
            success: false,
            error: error.message || 'Print job failed'
        });
    }
});

// Error handler
app.use((err, req, res, next) => {
    logger.error('Server error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    logger.info(`🖨️ EasyMaz Printer Bridge running on port ${PORT}`);
    logger.info(`Printer IP: ${process.env.PRINTER_IP || 'Not configured'}`);
    logger.info(`Printer Port: ${process.env.PRINTER_PORT || 'Not configured'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    logger.info('SIGTERM received, shutting down gracefully');
    process.exit(0);
});
