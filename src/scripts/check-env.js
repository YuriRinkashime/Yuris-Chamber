import 'dotenv/config';
console.log('CWD', process.cwd());
console.log('DB_DRIVER', process.env.DB_DRIVER || '(missing)');
console.log('MONGODB_URI', process.env.MONGODB_URI ? 'set len=' + process.env.MONGODB_URI.length : 'MISSING');
console.log('FIREBASE_SERVICE_ACCOUNT', process.env.FIREBASE_SERVICE_ACCOUNT ? 'set len=' + process.env.FIREBASE_SERVICE_ACCOUNT.length : 'MISSING');
