const dbUrl = process.env.CLEARDB_DATABASE_URL;
const url = new URL(dbUrl);

const dbConfig = {
    host: url.hostname,
    user: url.username,
    password: url.password,
    database: url.pathname.substring(1),
    connectionLimit: 10
  };

  module.exports = dbConfig;