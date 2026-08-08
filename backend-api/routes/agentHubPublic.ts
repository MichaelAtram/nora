// @ts-nocheck
const express = require("express");
const agentHubStore = require("../agentHubStore");
const snapshots = require("../snapshots");
const { requireAgentHubApiKey } = require("../agentHubApiKeys");
const { scanTemplatePayloadForSecrets } = require("../agentHubSafety");
const {
  extractTemplateDefaultsFromSnapshot,
  extractTemplatePayloadFromSnapshot,
  normalizeTemplatePayload,
  resolveTemplatePayloadRuntimeFamily,
  stripInternalTemplateMetadata,
  summarizeTemplatePayload,
} = require("../agentPayloads");
const {
  DEFAULT_RUNTIME_FAMILY,
  normalizeRuntimeFamilyName,
} = require("../../agent-runtime/lib/backendCatalog");

const router = express.Router();

function normalizeText(value, fallback = "", maxLength = 255) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return (normalized || fallback).slice(0, maxLength);
}

function normalizeDescription(value, fallback = "", maxLength = 1200) {
  if (typeof value !== "string") return String(fallback || "").slice(0, maxLength);
  return value.trim().slice(0, maxLength);
}

function normalizeCategory(value) {
  return normalizeText(value, "General", 60) || "General";
}

// Decision-6 family resolution for inbound submissions: explicit listing field
// first, then the submission's defaults block, then the template payload's
// metadata carrier (how bundles survive federation through hubs that predate
// runtime_family), defaulting to OpenClaw.
function resolveSubmittedRuntimeFamily(listingPayload, defaults, templatePayload) {
  const carriers = [
    listingPayload?.runtimeFamily ?? listingPayload?.runtime_family,
    defaults?.runtime_family ?? defaults?.runtimeFamily,
  ];
  for (const carrier of carriers) {
    const candidate = String(carrier ?? "").trim();
    if (candidate) return normalizeRuntimeFamilyName(candidate);
  }
  return resolveTemplatePayloadRuntimeFamily(normalizeTemplatePayload(templatePayload));
}

function requestBaseUrl(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] || "")
    .split(",")[0]
    .trim();
  const protocol = forwardedProto || req.protocol || "https";
  const host = forwardedHost || req.get("host") || "";
  return host ? `${protocol}://${host}` : "";
}

function buildPublisher(listing = {}, sourceHubUrl = "") {
  const displayName = listing.owner_name || "Nora Community";
  return {
    displayName,
    avatar: listing.owner_avatar || null,
    verified: Boolean(listing.owner_user_id),
    sourceHubUrl,
  };
}

function buildCatalogListing(listing, snapshot = null, templatePayload = null, options = {}) {
  const template = templatePayload
    ? summarizeTemplatePayload(templatePayload, {
        includeContent: false,
        runtimeFamily: listing?.runtime_family || null,
      })
    : null;
  const publisher = buildPublisher(listing, options.sourceHubUrl || "");

  return {
    id: listing.id,
    slug: listing.slug,
    name: listing.name,
    description: listing.description,
    category: listing.category,
    price: listing.price || "Free",
    source_type: "community",
    status: listing.status,
    runtime_family: listing.runtime_family || DEFAULT_RUNTIME_FAMILY,
    ownerName: publisher.displayName,
    publisher,
    current_version: listing.current_version || 1,
    installs: listing.installs || 0,
    downloads: listing.downloads || 0,
    defaults: snapshot ? extractTemplateDefaultsFromSnapshot(snapshot) : null,
    snapshot: snapshot
      ? {
          id: snapshot.id,
          kind: snapshot.kind,
          templateKey: snapshot.template_key || null,
        }
      : null,
    template: template
      ? {
          fileCount: template.fileCount,
          memoryFileCount: template.memoryFileCount,
          integrationCount: template.integrationCount,
          channelCount: template.channelCount,
          requiredCoreCount: template.requiredCoreCount,
          presentRequiredCoreCount: template.presentRequiredCoreCount,
          missingRequiredCoreFiles: template.missingRequiredCoreFiles,
          hasBootstrap: template.hasBootstrap,
          extraFilesCount: template.extraFilesCount,
          coreFiles: template.coreFiles.map((file) => ({
            path: file.path,
            label: file.label,
            required: file.required,
            present: file.present,
            bytes: file.bytes,
            lineCount: file.lineCount,
            preview: file.preview,
          })),
        }
      : null,
  };
}

/**
 * Build authenticated catalog detail, including full template payload only for
 * the single-listing endpoint that explicitly requests content.
 *
 * @param {Object} listing - Published community listing.
 * @param {Object} [options={}] - Content and source-hub URL options.
 * @returns {Promise<Object>} Public catalog summary or detail.
 */
async function buildCatalogDetail(listing, { includeContent = false, sourceHubUrl = "" } = {}) {
  const snapshot = listing?.snapshot_id ? await snapshots.getSnapshot(listing.snapshot_id) : null;
  const templatePayload = snapshot
    ? extractTemplatePayloadFromSnapshot(snapshot, { includeBootstrap: true })
    : null;
  const summary = buildCatalogListing(listing, snapshot, templatePayload, { sourceHubUrl });
  if (!includeContent || !templatePayload) return summary;

  return {
    ...summary,
    defaults: snapshot ? extractTemplateDefaultsFromSnapshot(snapshot) : {},
    templatePayload,
    template: summarizeTemplatePayload(templatePayload, {
      includeContent: true,
      runtimeFamily: listing?.runtime_family || null,
    }),
  };
}

// API-key-authenticated catalog and submission routes

router.get("/catalog", requireAgentHubApiKey, async (req, res, next) => {
  try {
    const sourceHubUrl = requestBaseUrl(req);
    const listings = await agentHubStore.listCommunityCatalog();
    const items = await Promise.all(
      listings.map((listing) => buildCatalogDetail(listing, { sourceHubUrl })),
    );
    res.json({
      hub: {
        name: "Nora Agent Hub",
        url: sourceHubUrl,
      },
      items,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/catalog/:id", requireAgentHubApiKey, async (req, res, next) => {
  try {
    const sourceHubUrl = requestBaseUrl(req);
    const listing = await agentHubStore.getListing(req.params.id);
    if (
      !listing ||
      listing.source_type !== agentHubStore.LISTING_SOURCE_COMMUNITY ||
      listing.status !== agentHubStore.LISTING_STATUS_PUBLISHED ||
      ![
        agentHubStore.LISTING_SHARE_TARGET_COMMUNITY,
        agentHubStore.LISTING_SHARE_TARGET_BOTH,
      ].includes(listing.share_target)
    ) {
      return res.status(404).json({ error: "Listing not found" });
    }
    res.json(await buildCatalogDetail(listing, { includeContent: true, sourceHubUrl }));
  } catch (error) {
    next(error);
  }
});

router.post("/submissions", requireAgentHubApiKey, async (req, res, next) => {
  try {
    const payload = req.body || {};
    const listingPayload = payload.listing || payload;
    const templatePayload = stripInternalTemplateMetadata(
      payload.templatePayload || payload.template_payload || {},
    );
    const issues = scanTemplatePayloadForSecrets(templatePayload);
    if (issues.length > 0) {
      return res.status(400).json({
        error: "Potential secrets were detected in this template. Remove them before sharing.",
        issues,
      });
    }

    const name = normalizeText(listingPayload.name, "Community Template", 100);
    const description = normalizeDescription(listingPayload.description);
    const category = normalizeCategory(listingPayload.category);
    const runtimeFamily = resolveSubmittedRuntimeFamily(
      listingPayload,
      payload.defaults,
      templatePayload,
    );
    const snapshot = await snapshots.createSnapshot(
      null,
      name,
      description,
      {
        kind: "community-template",
        defaults: payload.defaults || {},
        templatePayload,
      },
      {
        kind: "community-template",
        builtIn: false,
        templateKey: payload.snapshot?.templateKey || payload.snapshot?.template_key || null,
      },
    );
    const listing = await agentHubStore.upsertListing({
      snapshotId: snapshot.id,
      ownerUserId: req.agentHubPublisher.id,
      name,
      description,
      price: "Free",
      category,
      builtIn: false,
      sourceType: agentHubStore.LISTING_SOURCE_COMMUNITY,
      runtimeFamily,
      status: agentHubStore.LISTING_STATUS_PENDING_REVIEW,
      visibility: agentHubStore.LISTING_VISIBILITY_PUBLIC,
      shareTarget: agentHubStore.LISTING_SHARE_TARGET_COMMUNITY,
      localVisibility: agentHubStore.LISTING_LOCAL_VISIBILITY_OWNER,
      centralShareStatus: agentHubStore.CENTRAL_SHARE_STATUS_SUBMITTED,
      cloneMode: "files_only",
    });

    res.status(202).json({
      id: listing.id,
      listingId: listing.id,
      status: listing.status,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
