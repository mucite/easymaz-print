const express = require('express');
const { printReceipt } = require('./qzService');
const { PrintPayloadSchema} = require('./validation');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

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

app.listen(PORT, () => {
    console.log(`Node print service listening on http://localhost:${PORT}`);
});
