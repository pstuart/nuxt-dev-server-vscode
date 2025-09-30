# Publishing to VS Code Marketplace

This guide explains how to publish the Nuxt Dev Server Manager extension to the Visual Studio Code Marketplace.

## Prerequisites

1. **Microsoft Account**: You need a Microsoft account to create a publisher
2. **Azure DevOps Organization**: Required for creating a Personal Access Token (PAT)
3. **Publisher ID**: Register as a publisher on the marketplace

## One-Time Setup

### 1. Create a Publisher Account

1. Go to [Visual Studio Marketplace Publisher Management](https://marketplace.visualstudio.com/manage)
2. Sign in with your Microsoft account
3. Click "Create publisher"
4. Fill in the details:
   - **Name**: `pstuart` (must match the `publisher` field in package.json)
   - **ID**: `pstuart`
   - **Display Name**: Your display name
   - **Email**: Your contact email

### 2. Create a Personal Access Token (PAT)

1. Go to [Azure DevOps](https://dev.azure.com/)
2. Sign in with the same Microsoft account
3. Click on your user icon (top right) → "Personal access tokens"
4. Click "New Token"
5. Configure the token:
   - **Name**: `vsce-publish-token` (or any name you prefer)
   - **Organization**: Select "All accessible organizations"
   - **Expiration**: Set to 1 year (or custom)
   - **Scopes**: Select "Custom defined" → Check **"Marketplace (Manage)"**
6. Click "Create"
7. **IMPORTANT**: Copy the token immediately - you won't be able to see it again

### 3. Add Token to GitHub Secrets

1. Go to your GitHub repository
2. Navigate to: Settings → Secrets and variables → Actions
3. Click "New repository secret"
4. Add the secret:
   - **Name**: `VSCE_PAT`
   - **Value**: Paste the PAT token you copied
5. Click "Add secret"

## Publishing Methods

### Method 1: Automatic Publishing (GitHub Release)

1. Update version in package.json (or it will auto-bump on package):
   ```bash
   npm run version:patch  # 0.0.2 -> 0.0.3
   # or
   npm run version:minor  # 0.0.2 -> 0.1.0
   # or
   npm run version:major  # 0.0.2 -> 1.0.0
   ```

2. Commit and push changes:
   ```bash
   git add package.json
   git commit -m "Bump version to 0.0.3"
   git push
   ```

3. Create a GitHub Release:
   ```bash
   git tag v0.0.3
   git push origin v0.0.3
   ```

4. Go to GitHub → Releases → Create new release
5. Choose the tag you just created
6. Write release notes
7. Click "Publish release"

The GitHub Action will automatically:
- Build the extension
- Publish to VS Code Marketplace
- Attach the VSIX file to the release

### Method 2: Manual Workflow Dispatch

1. Go to GitHub → Actions
2. Select "Publish Extension" workflow
3. Click "Run workflow"
4. Optionally specify a version (e.g., `0.0.3`)
5. Click "Run workflow"

### Method 3: Manual Local Publishing

```bash
# Make sure you're logged in (one-time)
npx vsce login pstuart

# Publish
npx vsce publish

# Or publish with a specific version bump
npx vsce publish patch  # 0.0.2 -> 0.0.3
npx vsce publish minor  # 0.0.2 -> 0.1.0
npx vsce publish major  # 0.0.2 -> 1.0.0
```

## Version Management

The extension follows semantic versioning (semver):

- **Patch** (0.0.X): Bug fixes, small improvements
- **Minor** (0.X.0): New features, non-breaking changes
- **Major** (X.0.0): Breaking changes

Use the npm scripts:
```bash
npm run version:patch  # Bug fixes
npm run version:minor  # New features
npm run version:major  # Breaking changes
npm run package        # Auto-bumps patch and packages
```

## Verifying Publication

After publishing, verify your extension:

1. Go to [VS Code Marketplace](https://marketplace.visualstudio.com/)
2. Search for "Nuxt Dev Server Manager" or "pstuart"
3. Check that the latest version is showing
4. Install in VS Code:
   ```
   ext install pstuart.nuxt-dev-server
   ```

## Troubleshooting

### "Publisher not found"
- Make sure the `publisher` field in package.json matches your publisher ID
- Verify you've created the publisher on the marketplace

### "Authentication failed"
- Check that your PAT token is still valid (they expire)
- Verify the token has "Marketplace (Manage)" scope
- Make sure the GitHub secret `VSCE_PAT` is set correctly

### "Version already exists"
- You can't republish the same version
- Bump the version number in package.json
- Or use `npm run version:patch` to auto-increment

### "Icon not found"
- Ensure `icon.png` exists in the root directory
- Icon must be 128x128 pixels
- Must be PNG format

## Unpublishing (Emergency Only)

If you need to remove a version:

```bash
npx vsce unpublish pstuart.nuxt-dev-server@0.0.3
```

Or unpublish the entire extension:
```bash
npx vsce unpublish pstuart.nuxt-dev-server
```

**Warning**: Unpublishing is permanent and should be avoided if possible. Consider deprecating instead.

## CI/CD Workflow

The repository includes two workflows:

1. **CI** (`.github/workflows/ci.yml`):
   - Runs on every push/PR to main
   - Builds and packages the extension
   - Uploads VSIX as artifact for testing

2. **Publish** (`.github/workflows/publish.yml`):
   - Runs on GitHub releases
   - Publishes to VS Code Marketplace
   - Attaches VSIX to the release

## Resources

- [VS Code Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [vsce CLI Documentation](https://github.com/microsoft/vscode-vsce)
- [Marketplace Publisher Management](https://marketplace.visualstudio.com/manage)
- [Azure DevOps PAT Tokens](https://dev.azure.com/)