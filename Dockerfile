# Use an official Node.js runtime as the base image
FROM node:20

# Install system dependencies
RUN apk add pnpm

# Set the working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./app

# Install app dependencies
RUN pnpm install

# Copy the rest of the app's code
COPY . ./app

# Expose port 3000 (if applicable)
EXPOSE 3000

# Specify the command to run the app
CMD ["./server.sh"]
