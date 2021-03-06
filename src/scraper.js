const {
  isReservedSeating,
  clickAndNavigate,
  clickElemAndNavigate,
  readFilePromise,
  persistShowtimesForDay,
  getUrlParamByName
} = require("./util");
const aws = require("aws-sdk");
const s3 = new aws.S3({ apiVersion: "2006-03-01" });
const setup = require("./starter-kit/setup");

const S3_BUCKET = "hackathon.blazarus";
const BATCH_SIZE = 8;

// TODO should probably be disposing all of the elementHandles

// interface MovieSearch {
//   movie: Movie;
//   searchText: string;
//   date: string;
//   results: Theater[];
// }
// interface Movie {
//   movieId: string;
//   title: string;
//   showtimesUrl: string;
// }
// interface Theater {
//   name: string;
//   showtimeGroups: ShowtimeGroup[];
// }
// interface ShowtimeGroup {
//   description: string; // e.g. if it's imax, standard, etc.
//   showtimes: Showtime[];
// }
// interface Showtime {
//   time: string;
//   reservedSeating: boolean;
//   screenshotPath?: string; // the filename, only applicable if reserved seating is true
//   purchaseUrl: string; // url to fandango to go purchase tickets
//   movieId: string,
//   startDatetime: string, // this is a little redundant with time
//   theaterId: string,
//   showtimeId: string
// }

async function scrapeFandango(
  browserFactory,
  movieId,
  showtimesUrl,
  theaterSearch
) {
  let allDays;
  const browser = await browserFactory();
  const page = await browser.newPage();

  try {
    await page.goto(showtimesUrl);
    // Search for theaters in area code
    await page.evaluate(() => {
      document.querySelector(".date-picker__location input").value = "";
    });
    await page.type(".date-picker__location input", theaterSearch);
    await clickAndNavigate(page, ".date-picker__location a");

    allDays = await gatherAllTheaterInfo(browser, page);
    console.log("allDays", allDays);
  } catch (e) {
    console.log("Oops:", e.message);
    try {
      await page.screenshot({
        path: "error.jpeg",
        type: "jpeg",
        fullPage: true,
        quality: 50
      });
    } catch (e) {
      console.log("Error taking error screenshot: " + e);
    }
  }

  console.log("Done, closing page");
  await browser.close();
  return allDays;
}

async function scrapeDay(browserFactory, movieId, theaterSearch, day) {
  let currBatch = [];
  const batches = [currBatch];
  for (const theater of day.results) {
    for (const group of theater.showtimeGroups) {
      for (const showtime of group.showtimes) {
        if (showtime.reservedSeating) {
          if (currBatch.length >= BATCH_SIZE) {
            currBatch = [];
            batches.push(currBatch);
          }
          currBatch.push(showtime);
        }
      }
    }
  }

  for (const batch of batches) {
    const promises = batch.map(showtime =>
      getShowtimeScreenshot(browserFactory, showtime)
    );
    await Promise.all(promises);
  }

  const { date } = day;
  await persistShowtimesForDay(movieId, theaterSearch, date, day);
}

async function getShowtimeScreenshot(browserFactory, showtime) {
  console.log("Starting to process showtime:", showtime);
  const { purchaseUrl, showtimeId } = showtime;
  const browser = await browserFactory();
  const page = await browser.newPage();
  try {
    await page.goto(purchaseUrl, {
      waitUntil: ["domcontentloaded", "networkidle0"]
    });
    await page.waitForSelector("select", {
      timeout: 5000
    });
    await page.select("select.qtyDropDown", "1");
    await clickAndNavigate(page, "button");
    await Promise.all([
      page.waitForSelector("#seats_cover", { timeout: 5000 }),
      page.waitForSelector("#SeatPickerContainer", { timeout: 5000 })
    ]);

    const seatPickerHandle = await page.$("#SeatPickerContainer");

    // purchase url should be unique, so use that for the filename
    const filename = `seating-charts_${showtimeId}.png`;
    const path = `/tmp/${filename}`;

    await seatPickerHandle.screenshot({
      path,
      type: "png"
    });
    await seatPickerHandle.dispose();
    const screenshot = await readFilePromise(path);
    await s3
      .putObject({
        Bucket: S3_BUCKET,
        Key: filename,
        Body: screenshot
      })
      .promise();

    await page.close();
    await browser.close();

    // record path in the showtime object so we can retrieve later
    // record only after screenshot is actually successful
    showtime.screenshotPath = filename;
  } catch (e) {
    console.log("Error processing showtime with url:", purchaseUrl, e);
  }
}

async function doShowtime(page, i) {
  console.log("Starting showtime gathering", i);

  await page.waitForSelector("select", {
    timeout: 5000
  });
  await page.select("select.qtyDropDown", "1");
  await clickAndNavigate(page, "button");

  await page.screenshot({
    path: `images/seating-chart-${i}.png`,
    type: "png",
    fullPage: true
  });
}

async function gatherAllTheaterInfo(browser, page) {
  // Not sure why, but I wasn't able to get the date correctly using puppeteers methods
  const dates = await page.evaluate(() => {
    const res = [];
    for (const elem of document.querySelectorAll(
      "li.date-picker__date:not(.date-picker__date--no-showtime)"
    )) {
      res.push({
        href: elem.querySelector("a").getAttribute("href"),
        date: elem.getAttribute("data-show-time-date")
      });
    }
    return res;
  });
  console.log(dates);
  const promises = [];
  for (const dateObj of dates) {
    const newPage = await browser.newPage();
    await newPage.goto(page.url() + dateObj.href);
    const promise = gatherInfoForDay(newPage);
    promises.push(promise);
    promise.then(dayResults => {
      dateObj.results = dayResults;
    });
  }
  await Promise.all(promises);
  return dates;
}

async function gatherInfoForDay(page) {
  const results = [];

  for (const theaterHandle of await page.$$(".theater__wrap")) {
    const theaterResults = {};
    const nameElem = await theaterHandle.$(".theater__name-wrap h3 a");
    theaterResults.name = await (await nameElem.getProperty(
      "innerText"
    )).jsonValue();
    console.log("theater name:", theaterResults.name);
    await nameElem.dispose();

    theaterResults.showtimeGroups = [];
    for (const showtimeGroupHandle of await theaterHandle.$$(
      ".theater__showtimes"
    )) {
      theaterResults.showtimeGroups.push(
        await getShowtimeGroupInfo(showtimeGroupHandle)
      );
      await showtimeGroupHandle.dispose();
    }
    results.push(theaterResults);
    await theaterHandle.dispose();
  }

  return results;
}

async function getShowtimeGroupInfo(showtimeGroupHandle) {
  const results = {};

  const tickHeadlineHandle = await showtimeGroupHandle.$(
    ".theater__tick-headline"
  );
  results.description = await (await tickHeadlineHandle.getProperty(
    "innerText"
  )).jsonValue();
  console.log("description", results.description);
  await tickHeadlineHandle.dispose();
  const reservedSeating = await isReservedSeating(showtimeGroupHandle);
  console.log("reserved seating?", reservedSeating);

  results.showtimes = [];
  for (const showtimeButtonHandle of await showtimeGroupHandle.$$(
    ".theater__btn-list-item .showtime-btn--available"
  )) {
    const purchaseUrl = await (await showtimeButtonHandle.getProperty(
      "href"
    )).jsonValue();
    const time = await (await showtimeButtonHandle.getProperty(
      "innerText"
    )).jsonValue();
    await showtimeButtonHandle.dispose();
    const movieId = getUrlParamByName(purchaseUrl, "mid");
    const startDatetime = getUrlParamByName(purchaseUrl, "sdate");
    const theaterId = getUrlParamByName(purchaseUrl, "tid");
    const showtimeId = `${movieId}__${theaterId}__${startDatetime}`;
    console.log(time, purchaseUrl);
    results.showtimes.push({
      time,
      reservedSeating,
      purchaseUrl,
      movieId,
      startDatetime, // this is a little redundant with time
      theaterId,
      showtimeId
    });
  }

  return results;
}

module.exports = {
  scrapeFandango,
  scrapeDay
};
