require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const schedule = require('node-schedule');
const nodemailer = require('nodemailer');
const diff = require('diff');
const colors = require('colors');
const fs = require('fs');
const sanitizeHtml = require('sanitize-html');
const app = express();
const port = process.env.PORT || 3000;
const mysql = require('mysql');
const dbConfig = require('./config/databaseConfig');
const checkInterval = '0 */3 * * *';

const monitoredUrls = new Map(); // URLとそれに対応するpreviousHtmlを保持するマップ

const pool = mysql.createPool(dbConfig);

const slackConfig = {
  webhookUrl: process.env.SLACK_WEBHOOK_URL
};

const savePreviousHtml = async (url, previousHtml) => {
  const query = 'INSERT INTO monitored_urls (url, previous_html) VALUES (?, ?) ON DUPLICATE KEY UPDATE previous_html = ?';
  const values = [url, previousHtml, previousHtml];
  return new Promise((resolve, reject) => {
    pool.query(query, values, (error, results) => {
      if (error) {
        console.error('データベース保存エラー:', error);
        reject(error);
      } else {
        console.log('データベースに保存されたデータ:', results);
        monitoredUrls.set(url, previousHtml); // monitoredUrlsにも保存する
        resolve(results);
      }
    });
  });
};



const getPreviousHtml = async (url) => {
  const query = 'SELECT previous_html FROM monitored_urls WHERE url = ?';
  const values = [url];
  return new Promise((resolve, reject) => {
    pool.query(query, values, (error, results) => {
      if (error) {
        console.error('getPreviousHtmlエラーが発生しました:', error);
        reject(error);
      } else {
        console.log('データベースから取得したデータ:', results);
        const previousHtml = results[0]?.previous_html;
        monitoredUrls.set(url, previousHtml); // monitoredUrlsにも保存する
        resolve(previousHtml);
      }
    });
  });
};


const saveNewUrl = async (url) => {
  const query = 'INSERT INTO monitored_urls (url, previous_html) VALUES (?, ?)';
  const values = [url, null];
  return new Promise((resolve, reject) => {
    pool.query(query, values, (error, results) => {
      if (error) {
        console.error('データベース保存エラー:', error);
        reject(error);
      } else {
        console.log('データベースに保存されたデータ:', results);
        resolve(results);
      }
    });
  });
};



const sendSlackNotification = async (text) => {
  const message = {
    text: text
  };

  try {
    await axios.post(slackConfig.webhookUrl, message);
    console.log('Slackに通知が送信されました');
  } catch (error) {
    console.error('Slackの送信中にエラーが発生しました:', error);
  }
};

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');

app.post('/add', async (req, res) => {
  try {
    const url = req.body.url;
    console.log('URLを追加:', url);

    const pool = mysql.createPool(dbConfig);

        // DBにURLを追加するクエリを実行
        const query = 'INSERT INTO monitored_urls (url) VALUES (?) ON DUPLICATE KEY UPDATE url = ?';
        const values = [url, url];

    pool.query(query, values, (error, results) => {
      if (error) {
        console.error('データベース保存エラー:', error);
        res.status(500).send('エラーが発生しました');
      } else {
        console.log('データベースに保存されたデータ:', results);
        monitoredUrls.set(url, null); // monitoredUrlsにも保存する
        res.redirect('/');
      }
      pool.end(); // DBプールを解放する
    });
  } catch (error) {
    console.error('エラーが発生しました:', error);
    res.status(500).send('エラーが発生しました');
  }
});

app.post('/remove', async (req, res) => {
  try {
    const url = req.body.url;
    monitoredUrls.delete(url);
    res.redirect('/');
  } catch (error) {
    console.error('エラーが発生しました:', error);
    res.status(500).send('エラーが発生しました');
  }
});

app.get('/', (req, res) => {
  res.render('index', { monitoredUrls: Array.from(monitoredUrls.keys()) });
});

const checkForUpdates = async (url) => {
  try {
    console.log('リクエストを送信:', url); // 追加
    const response = await axios.get(url);
    const $ = cheerio.load(response.data);
    console.log('更新をチェック:', url);
    const currentHtml = sanitizeHtml($('html').html(), {
      allowedTags: sanitizeHtml.defaults.allowedTags.filter(tag => tag !== 'script' && tag !== 'style'),
      exclusiveFilter: (frame) => {
        // imgタグのsrc属性を保持
        if (frame.tag === 'img') {
          const src = frame.attribs.src;
          frame.attribs = { src: src };
        } else {
          // それ以外の要素の属性を削除
          frame.attribs = {};
        }
        return false;
      }
    });
    
    const previousHtml = await getPreviousHtml(url); console.log("getPreviousHtmlを実行")// ここを変更
    if (previousHtml !== null && currentHtml !== previousHtml) {
      console.log('更新があります:');
      const differences = diff.diffWords(previousHtml, currentHtml);
      differences.forEach((part) => {
        const value = part.value;
        const color = part.added ? 'green' : part.removed ? 'red' : 'grey';
        process.stderr.write(colors[color](value));
      });
      console.log();

      const subject = 'ウェブサイトが更新されました';
      const text = `ウェブサイトの更新を検出しました: ${url}`;
      sendSlackNotification(text);
      console.log(subject);
    }

    await savePreviousHtml(url, currentHtml); // ここを追加
    console.log("savePreviousHtmlを実行")
  } catch (error) {
    console.error('エラーが発生しました:', error);
  }
};



const loadMonitoredUrlsFromDb = async () => {
  const query = 'SELECT url, previous_html FROM monitored_urls';
  return new Promise((resolve, reject) => {
    pool.query(query, (error, results) => {
      if (error) {
        console.error('データベース読み込みエラー:', error);
        reject(error);
      } else {
        console.log('データベースから読み込んだURL:', results.map(result => result.url));
        results.forEach(result => {
          const url = result.url;
          const previousHtml = result.previous_html;
          if (!monitoredUrls.has(url)) {
            monitoredUrls.set(url, previousHtml);
            console.log("monitoredUrls.setを実行")
            schedule.scheduleJob(checkInterval, () => checkForUpdates(url));
          }
        });
        resolve();
      }
    });
  });
};

loadMonitoredUrlsFromDb();

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('エラーが発生しました');
});

app.listen(port, () => {
  console.log(`アプリケーションがポート${port}で起動しました`);
});