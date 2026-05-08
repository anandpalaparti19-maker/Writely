const allowedOriginPatterns = [
    /^https:\/\/([a-z0-9-]+\.)?netlify\.app$/i,
    /^https:\/\/([a-z0-9-]+\.)?onrender\.com$/i,
    /^https:\/\/([a-z0-9-]+\.)?web\.app$/i,
    /^https:\/\/([a-z0-9-]+\.)?firebaseapp\.com$/i,
    /^http:\/\/localhost(:\d+)?$/i,
    /^http:\/\/127\.0\.0\.1(:\d+)?$/i,
    /^http:\/\/192\.168\.\d+\.\d+(:\d+)?$/i
];

const origin = 'https://writely-304a8.web.app';
const matches = allowedOriginPatterns.some(rx => rx.test(origin));
console.log('Origin:', origin);
console.log('Matches:', matches);
