import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.gremlinsinc.web',
  appName: '地精公司',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    // 局域网联机：移动端通过本机 IP 连接服务端
    // 实际部署时在 App 内设置中填写服务端 IP
  },
  plugins: {
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#1a1a2e',
    },
    Keyboard: {
      resize: 'native',
      resizeOnFullScreen: true,
    },
  },
};

export default config;
