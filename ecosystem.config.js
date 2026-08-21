module.exports = {
  apps: [
    {
      name: 'mcsp',
      script: 'server.js',
      cwd: __dirname,
      exec_mode: 'fork',        // 应用有内存态(会话/实例),必须单进程 fork 模式
      autorestart: true,        // 崩溃自动拉起
      max_restarts: 10,
      restart_delay: 2000,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: process.env.PORT || 3000,
        // 指向 Java 21+(Paper 1.20.5+ 必需);系统 PATH 里有 java 时可删除此行
        JAVA_BIN: process.env.JAVA_BIN || `${process.env.HOME}/java/jdk-21.0.12+8-jre/bin/java`,
      },
      out_file: 'logs/pm2-out.log',
      error_file: 'logs/pm2-error.log',
      merge_logs: true,
      time: true,               // 日志带时间戳
    },
  ],
};
