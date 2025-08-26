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

      logger.info(`🆕 New print job received: ${doc.id}`);

      try {
        await printReceipt(data);
        await doc.ref.update({
          status: 'done',
          printedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        logger.info(`✅ Print job ${doc.id} completed.`);
      } catch (err) {
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
