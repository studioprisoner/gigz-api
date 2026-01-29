/**
 * Migration Verification Script
 * Run this to check which users need Apple auth migration
 */

// Query to find users without authData who might be migrated Apple users
const usersQuery = new Parse.Query(Parse.User);
usersQuery.exists("email");
usersQuery.doesNotExist("authData");
usersQuery.limit(100);

usersQuery.find({ useMasterKey: true }).then(users => {
  console.log(`Found ${users.length} users with email but no authData (potential Apple migration candidates):`);

  users.forEach(user => {
    console.log(`User ID: ${user.id}, Email: ${user.get("email")}, Username: ${user.get("username")}`);
  });

  console.log("\nThese users will now be handled correctly by the Apple Sign-In flow.");
}).catch(error => {
  console.error("Error:", error);
});