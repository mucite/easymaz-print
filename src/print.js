require('dotenv').config();
const admin = require('firebase-admin');
const path = require('path');
const printReceipt = require('./helper');
const winston = require('winston');

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

db.collection('printJobs')
	.where('status', '==', 'pending')
	.orderBy('createdAt', 'asc')
	.onSnapshot((snapshot) => {
		if (snapshot.empty) return;
		
		snapshot.docChanges().forEach(async (change) => {
			if (change.type !== 'added') return;
			
			const doc = change.doc;
			const data = doc.data();
			
			if (data.status !== 'pending') return;
			
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
					return;
				}
				
				logger.error(`❌ Failed to print job ${doc.id}:`, err);
				await doc.ref.update({
					status: 'error',
					errorMessage: err.message || 'Unknown error',
				});
			}
		});
	});

process.on('SIGINT', () => {
	logger.info('Process terminated');
	process.exit(0);
});
