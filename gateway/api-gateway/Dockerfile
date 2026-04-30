FROM node:20-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy the rest of the backend code
COPY . .

# Expose the port (matches .env PORT or 5001)
EXPOSE 5001

# Start the server
CMD ["node", "server.js"]
