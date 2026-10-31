import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({plugins:[react()],base:'/petete/',build:{outDir:'dist/petete',emptyOutDir:true},server:{host:'0.0.0.0',port:5173,allowedHosts:['terminal.local'],proxy:{'/petete/api':{target:'http://127.0.0.1:8787',changeOrigin:false}}}});
