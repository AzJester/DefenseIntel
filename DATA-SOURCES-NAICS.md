# NAICS reference provenance

The app embeds the U.S. Census Bureau's official **2022 NAICS Structure** as a local reference catalog, retrieved October 21, 2026. The current Census reference page still offered 2022 and listed the July 13, 2026 request for comments on proposed 2027 updates. The app does not present a proposed revision as an adopted code catalog.

- Official reference: https://www.census.gov/naics/
- Original downloaded XLSX: https://www.census.gov/naics/2022NAICS/2022_NAICS_Structure.xlsx
- Download size: 88,218 bytes.
- XLSX SHA-256: `217c9e0d4d74e7517bc288f5f308b73aa0de5ee787976a6dd222412be28ada22`
- Catalog: `public/naics-2022.json`. Its metadata includes the exact retrieval timestamp, original source URL, source hash, version, count and level counts.

All 2,125 official code/title rows were extracted from the workbook's first worksheet: 20 sectors, 96 subsectors, 308 industry groups, 689 five-digit NAICS industries and 1,012 six-digit U.S. industries. Sector ranges `31-33`, `44-45` and `48-49` remain as published; individual sector identifiers were not fabricated. Every code is unique, has an official title and has a valid parent, except the top-level sectors. Parent relationships derive from the official prefixes and sector ranges. The workbook's superscript T comparison marker is stored separately as `trilateral`, rather than appended to titles. Change indicators are retained separately.

The reference search runs locally against the saved catalog. It is not a live SAM solicitation search or an eligibility engine. Codes attached to saved pursuits are analyst planning tags; updating them preserves the latest pursuit's other fields and assessments. Users are directed to the actual notice and official definitions before relying on a classification.

Official related references:

- Census definition/search links use the published 2022 reference interface.
- SAM.gov opportunities and advanced search: https://sam.gov/opportunities and https://sam.gov/search/?index=opp
- Federal NAICS guidance: https://www.acquisition.gov/far/19.102
- Product and Service Code reference: https://www.acquisition.gov/psc-manual/all

The app makes no claim that a NAICS code establishes small-business size, registration, CAGE identity or award eligibility. Census is the source of code titles; pursuit associations are user-entered classifications.
