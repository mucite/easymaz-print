require('dotenv').config();
const admin = require('firebase-admin');
const path = require('path');
const printReceipt = require('./helper');
const winston = require('winston');
const isOnline = require('is-online');

const logger = winston.createLogger({
	level: 'info',
	transports: [
		new winston.transports.Console({
			format: winston.format.simple()
		})
	]
});

const serviceAccount = require(path.resolve(__dirname, '../config/easymaz-go.json'));

admin.initializeApp({
	credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

logger.info('🖨️ Waiting for new print jobs...');

const restaurantId = process.env.RESTAURANT_ID;
let unsubscribe = null;

async function startListener() {
	logger.info('🚀 Starting Firestore listener...');
	
	// Check for internet
	const online = await isOnline();
	if (!online) {
		logger.warn('❌ No internet. Retrying in 10 seconds...');
		setTimeout(startListener, 10000);
		return;
	}
	
	try {
		unsubscribe = db.collection('printJobs')
			.where('status', '==', 'pending')
			.where('restaurantId', '==', restaurantId)
			.orderBy('createdAt', 'asc')
			.onSnapshot(async (snapshot) => {
				if (snapshot.empty) return;
				
				for (const change of snapshot.docChanges()) {
					if (change.type !== 'added') continue;
					
					const doc = change.doc;
					const data = doc.data();
					
					if (data.status !== 'pending') continue;
					
					try {
						// Attempt to claim the job atomically
						await db.runTransaction(async (t) => {
							const freshDoc = await t.get(doc.ref);
							if (freshDoc.data().status !== 'pending') {
								throw new Error('Already claimed by another worker');
							}
							t.update(doc.ref, {status: 'processing'});
						});
						
						logger.info(`🆕 Claimed print job: ${doc.id}`);
						
						// Process the job
						await printReceipt(data);
						
						await doc.ref.update({
							status: 'done',
							printedAt: admin.firestore.FieldValue.serverTimestamp(),
						});
						
						logger.info(`✅ Print job ${doc.id} completed.`);
					} catch (err) {
						if (err.message.includes('Already claimed')) {
							logger.info(`⚠️ Job ${doc.id} was already taken by another worker`);
							continue;
						}
						
						logger.error(`❌ Failed to print job ${doc.id}:`, err);
						await doc.ref.update({
							status: 'error',
							errorMessage: err.message || 'Unknown error',
						});
					}
				}
			}, (error) => {
				logger.error('🔥 Firestore listener error:', error.message);
				// Remove the listener
				if (unsubscribe) unsubscribe();
				unsubscribe = null;
				
				// Retry after delay
				setTimeout(startListener, 10000);
			});
		
	} catch (err) {
		logger.error('❌ Failed to set up listener:', err.message);
		setTimeout(startListener, 10000);
	}
}

// Start the listener
await startListener();

process.on('SIGINT', () => {
	if (unsubscribe) unsubscribe();
	logger.info('Process terminated');
	process.exit(0);
});
