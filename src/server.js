const express = require('express');
const { printReceipt } = require('./qzService');
const { PrintPayloadSchema} = require('./validation');
const qz = require("qz-tray");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

app.get("/health", (req, res) => {
    res.status(200).json({ status: "ok" });
});

app.post('/print', async (req, res) => {
    const parsed = PrintPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
        const errors = parsed.error.issues.map(issue => {
            const path = issue.path.join('.');
            return path ? `${path}: ${issue.message}` : issue.message;
        });

        return res.status(400).json({
            success: false,
            errors
        });
    }

    const receipt = parsed.data;

    try {
        await printReceipt(receipt);
        return res.json({ success: true });
    } catch (err) {
        console.error('Print error:', err);
        return res.status(502).json({
            success: false,
            error: err.message || 'Failed to print via QZ Tray'
        });
    }
});

async function closeConnection() {
    if (qz.websocket.isActive()) {
        try {
            await qz.websocket.disconnect();
            console.log('QZ websocket disconnected');
        } catch (err) {
            console.error('Error disconnecting QZ websocket:', err);
        }
    }
}

process.on('SIGINT', async () => {
    console.log('Received SIGINT, closing QZ websocket...');
    await closeConnection();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('Received SIGTERM, closing QZ websocket...');
    await closeConnection();
    process.exit(0);
});

app.listen(PORT, () => {
    console.log(`Node print service listening on http://localhost:${PORT}`);
});
