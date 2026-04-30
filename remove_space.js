const fs = require('fs');
const path = require('path');

function walkDir(dir, callback) {
    fs.readdirSync(dir).forEach(f => {
        let dirPath = path.join(dir, f);
        let isDirectory = fs.statSync(dirPath).isDirectory();
        if (isDirectory) {
            if (f !== 'node_modules' && f !== '.git' && f !== '.next') {
                walkDir(dirPath, callback);
            }
        } else {
            callback(dirPath);
        }
    });
}

const extensions = ['.html', '.js', '.ts', '.css', '.md', '.json'];

walkDir(__dirname, (filePath) => {
    if (!extensions.includes(path.extname(filePath))) return;
    
    let content = fs.readFileSync(filePath, 'utf8');
    let original = content;
    
    // Replace the split logo markup with a single word
    content = content.replace(/write<span>ly<\/span>/g, 'Writely');
    
    if (content !== original) {
        fs.writeFileSync(filePath, content, 'utf8');
        console.log('Updated:', filePath);
    }
});
console.log('Rename completed.');
