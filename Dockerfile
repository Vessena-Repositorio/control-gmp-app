FROM node:22-alpine

WORKDIR /app

# Las dependencias se instalan primero para que un cambio en los .html no
# invalide la capa de node_modules y el deploy sea rapido.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

# Coolify usa esto para saber si el contenedor esta sano. Apunta a /api/salud,
# que responde 503 si la base no contesta. start-period le da margen al arranque
# para migrar y correr la primera replica.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/api/salud').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
