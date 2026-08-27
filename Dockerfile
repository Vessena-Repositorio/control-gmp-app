FROM node:22-alpine

WORKDIR /app

# Las dependencias se instalan primero para que un cambio en los .html no
# invalide la capa de node_modules y el deploy sea rapido.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server/index.js"]
