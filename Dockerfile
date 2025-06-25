# Use official Node.js image
FROM node:18

# Install PM2 globally
RUN npm install -g pm2

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN npm install --only=production

# Copy the worker script
COPY . .

# Set environment variables (can be overridden in docker-compose)
ENV NODE_ENV=production

# Run worker script with PM2
CMD ["pm2-runtime", "index.js"]