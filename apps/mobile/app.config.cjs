const app = require("./app.json");

const committedProjectId = app.expo.extra.eas.projectId;

module.exports = () => {
  const projectId = process.env.EAS_PROJECT_ID?.trim();
  const appleTeamId = process.env.APPLE_TEAM_ID?.trim();
  if (projectId && projectId !== committedProjectId) {
    throw new Error("EAS_PROJECT_ID must equal the committed @imnibis/stash-capture project UUID");
  }
  if (appleTeamId && !/^[A-Z0-9]{10}$/.test(appleTeamId)) {
    throw new Error("APPLE_TEAM_ID must be the 10-character Apple Developer team identifier");
  }
  return {
    ...app.expo,
    ...(appleTeamId ? { ios: { ...app.expo.ios, appleTeamId } } : {}),
    extra: { ...app.expo.extra, eas: { projectId: committedProjectId } }
  };
};
