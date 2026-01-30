#!/usr/bin/env bun
/**
 * Verify the UserConcert fix is working
 */

import "dotenv/config";

// Initialize Parse
const Parse = require("parse/node");
Parse.initialize(
  process.env.PARSE_APP_ID!,
  process.env.PARSE_CLIENT_KEY,
  process.env.PARSE_MASTER_KEY!
);
Parse.serverURL = process.env.PARSE_SERVER_URL!;

async function testAddConcert() {
  console.log("🧪 Testing addConcert function...\n");

  try {
    // First, get a test user (or create one)
    const userQuery = new Parse.Query(Parse.User);
    userQuery.limit(1);
    let user = await userQuery.first({ useMasterKey: true });

    if (!user) {
      console.log("Creating test user...");
      user = new Parse.User();
      user.set("username", "test_" + Date.now());
      user.set("password", "testpass123");
      user.set("email", `test_${Date.now()}@test.com`);
      await user.signUp(null, { useMasterKey: true });
    }

    console.log(`Using user: ${user.id} (${user.get("username")})`);

    // Get a test artist
    const artistQuery = new Parse.Query("Artist");
    artistQuery.limit(1);
    let artist = await artistQuery.first({ useMasterKey: true });

    if (!artist) {
      console.log("Creating test artist...");
      const Artist = Parse.Object.extend("Artist");
      artist = new Artist();
      artist.set("name", "Test Artist " + Date.now());
      artist.set("slug", "test-artist-" + Date.now());
      await artist.save(null, { useMasterKey: true });
    }

    console.log(`Using artist: ${artist.id} (${artist.get("name")})`);

    // Get a test venue
    const venueQuery = new Parse.Query("Venue");
    venueQuery.limit(1);
    let venue = await venueQuery.first({ useMasterKey: true });

    if (!venue) {
      console.log("Creating test venue...");
      const Venue = Parse.Object.extend("Venue");
      venue = new Venue();
      venue.set("name", "Test Venue " + Date.now());
      venue.set("slug", "test-venue-" + Date.now());
      venue.set("city", "Test City");
      venue.set("country", "Test Country");
      await venue.save(null, { useMasterKey: true });
    }

    console.log(`Using venue: ${venue.id} (${venue.get("name")})`);

    // Now test the addConcert cloud function
    console.log("\n📝 Calling addConcert cloud function...");

    const result = await Parse.Cloud.run("addConcert", {
      artist_id: artist.id,
      venue_id: venue.id,
      concert_date: new Date().toISOString(),
      notes: "Test concert added via fix verification",
      rating: 5
    }, { sessionToken: user.getSessionToken() });

    console.log("\n✅ SUCCESS! Concert added:");
    console.log(`  UserConcert ID: ${result.objectId}`);
    console.log(`  Artist: ${result.concert.artist.name}`);
    console.log(`  Venue: ${result.concert.venue.name}`);
    console.log(`  Notes: ${result.notes}`);
    console.log(`  Rating: ${result.rating}`);

    // Clean up - delete the test concert
    console.log("\n🧹 Cleaning up test data...");
    const deleteQuery = new Parse.Query("UserConcert");
    const userConcert = await deleteQuery.get(result.objectId, { useMasterKey: true });
    await userConcert.destroy({ useMasterKey: true });
    console.log("Test concert deleted");

    console.log("\n✅ All tests passed! The fix is working correctly.");

  } catch (error) {
    console.error("\n❌ Test failed with error:");
    console.error(error);

    if (error.code === 141) {
      console.error("\nError details:", error.message);
    }

    process.exit(1);
  }
}

// Run the test
testAddConcert().catch(console.error);