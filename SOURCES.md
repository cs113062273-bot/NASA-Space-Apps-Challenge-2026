# LUNORIZON data, references and software credits

This page brings together the NASA datasets, engineering references, mission sources, software and visual assets used to develop LUNORIZON. Each entry identifies its contribution to the project.

## NASA data

| Resource | Contribution |
|---|---|
| [LRO LOLA polar and global elevation models](https://pds-geosciences.wustl.edu/missions/lro/lola.htm) | Curated and browser-computed terrain horizons, surface heights, terrain tiles, maps and lunar-limb checks. Products include LDEM_80S_20M, LDEM_80S_80M, LDEM_75S_240M, LDEM_60S_240M, LDEM_512, LDEM_64 and LDEM_16. |
| [GSFC high-resolution LOLA south-pole topography](https://pgda.gsfc.nasa.gov/products/78) | Native 5 m height, slope, slope RMS, height RMS and return-count products for landing footprints and terrain routes. |
| [LROC NAC stereo terrain archive](https://data.lroc.im-ldi.com/lroc/rdr_product_select?filter%5Btext%5D=NAC_DTM) | NOBILE03 and VIKRAMSITE1 near-field terrain, plus ESALL_CR1, ESALL_SR12 and ESALL_MP1 stereo models for polar terrain comparisons. NASA / Arizona State University, with DLR polar stereo products. |
| [JPL NAIF SPICE generic kernels](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/) | DE440 Sun/Earth vectors and lunar orientation, DE421 reference-orbit inputs, lunar frames, leap seconds, Earth orientation and moving reference-station geometry. |
| [JPL Horizons](https://ssd.jpl.nasa.gov/horizons/) | External comparisons of Sun/Earth directions and DSN receiver elevations. |
| [GSFC lunar polar illumination maps, PGDA product 69](https://pgda.gsfc.nasa.gov/products/69) | Regional illumination comparison against AVGVISIB_85S_060M_201608. |
| [LRO Diviner Polar Resource Product V2](https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/catalog/prpds.cat) | Published annual thermal context, including mean temperature at 2 cm depth and annual surface maximum. |

The source records retain individual files, acquisition metadata and SHA-256 fingerprints:

- [NAIF kernels](lunar/data/validation/kernels.json)
- [Native 5 m terrain sources](lunar/data/validation/site-terrain-source.json)
- [Diviner source products](lunar/data/validation/diviner-prp-source.json)
- [Reference-orbit sources](lunar/data/validation/relay-sources.json)
- [Whole-Moon limb terrain](lunar/data/validation/limb-dem-source.json)

## NASA references

| Resource | Contribution |
|---|---|
| [GRAIL GRGM900C gravity coefficients](https://pds-geosciences.wustl.edu/grail/grail-l-lgrs-5-rdr-v1/grail_1001/shadr/) | Degree/order 25 gravity in the reference-constellation propagation pipeline. |
| [DSN Telecommunications Link Design Handbook, 810-005](https://deepspace.jpl.nasa.gov/dsndocs/810-005/) | Reference-station information and 34 m antenna link-budget inputs. |
| [DSN module 104 Rev. L](https://deepspace.jpl.nasa.gov/dsndocs/810-005/104/104L.pdf) | S/X-band gain and system-temperature inputs used in the direct-link model. |
| [DSN module 104 Rev. P](https://deepspace.jpl.nasa.gov/dsndocs/810-005/104/104P.pdf) | Additional review of station and receiver configurations. |
| [Morabito, IPN Progress Report 42-166](https://ipnpr.jpl.nasa.gov/progress_report/42-166/166C.html) | Lunar radio-noise contribution to a DSN 34 m receiver. |
| [Artemis III site-selection study, NTRS 20250011660](https://ntrs.nasa.gov/citations/20250011660) | Candidate-region selection logic and time-dependent sunlight, terrain and communication criteria. |
| [Glaser et al., illumination conditions at the lunar poles](https://ntrs.nasa.gov/citations/20170007365) | Published ridge/rim coordinates and long-term illumination comparisons. |
| [LCRNS Reference Constellation 3.1](https://ntrs.nasa.gov/citations/20250002698) | Published initial spacecraft states and reference propagation settings. |
| [Lunar Relay Services Requirements Document](https://www.nasa.gov/wp-content/uploads/2025/08/lunar-relay-services-requirements-document-srd.pdf) | User-terminal requirements consulted for the editable relay RF scenarios. |
| [LunaNet Interoperability Specification](https://www.nasa.gov/directorates/somd/space-communications-navigation-program/lunanet-interoperability-specification/) | Communication service concepts and real-time/store-and-forward distinctions. |
| [Onboard Processing for LunaNet Data Services](https://ntrs.nasa.gov/citations/20240012437) | Contact, storage and relay service-planning references. |
| [Passive Thermal Control Engineering Guidebook](https://ntrs.nasa.gov/citations/20220006584) | Radiation and view-factor references for the equipment-node heat equation. |
| [Colozza, NASA/CR-2020-220368](https://ntrs.nasa.gov/citations/20200001622) | Lunar power-system storage and efficiency references. |
| [Oleson et al., NASA/TM-20210020132](https://ntrs.nasa.gov/citations/20210020132) | Rover power-system charging, discharging and depth-of-discharge references. |
| [AeSI Phase I report](https://ntrs.nasa.gov/citations/20250002164) | Thermal/heater requirements considered in power-model development. |
| [Moon Trek technical abstract](https://ntrs.nasa.gov/citations/20220010585) | Terrain, visibility and geospatial workflow research. |
| [DSN mission-support explanation](https://www.nasa.gov/technology/space-comms/deep-space-network/how-nasas-deep-space-network-supports-the-agencys-missions/) | Ground-contact allocation and onboard-storage context. |
| [Madrid weekly antenna schedules](https://www.mdscc.nasa.gov/index.php/en/mdscc-antennas-weekly-schedule/) | Reference for dated station-pass descriptions. |

Relevant NAIF documentation includes [illumination](https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/C/cspice/illumf_c.html), [constant-position surface observers](https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/C/cspice/spkcpt_c.html), [occultation](https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/C/cspice/occult_c.html), [surface intercepts](https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/C/cspice/sincpt_c.html) and [SPK type 13 writing](https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/C/cspice/spkw13_c.html).

### NASA images and landing positions

| Resource | Contribution |
|---|---|
| [SDO/HMI visible-light Sun, 23 October 2014](https://images.nasa.gov/details/GSFC_20171208_Archive_e000923) | Sun texture in the skyline and 3D views. |
| [Apollo 17 Blue Marble, AS17-148-22727](https://images.nasa.gov/details/as17-148-22727) | Earth texture with calculated phase shading. |
| [NSSDCA Apollo lunar landing sites](https://nssdc.gsfc.nasa.gov/planetary/lunar/lunar_sites.html) | Apollo Lunar Module coordinates. |
| [LRO images of Odysseus](https://www.nasa.gov/missions/lro/nasas-lro-images-intuitive-machines-odysseus-lander/) | IM-1 landing-site information. |
| [LROC IM-2 landing region](https://www.lroc.asu.edu/images/1401) | Athena intended-site and regional imagery context. |
| [LRO images of Chang'e 6](https://www.nasa.gov/centers-and-facilities/goddard/nasas-lro-spots-chinas-change-6-spacecraft-on-lunar-far-side) | Chang'e 6 landing coordinates and mission context. |
| [LROC Chang'e 4 landing site](https://www.lroc.asu.edu/posts/1087) | Chang'e 4 coordinates. |
| [LROC first look at Chang'e 5](https://www.lroc.asu.edu/posts/1172) | Chang'e 5 coordinates. |

## Partner and other references

| Resource | Contribution |
|---|---|
| [JAXA SLIM briefing, December 2024](https://www.isas.jaxa.jp/en/topics/files/SLIM-press-briefing-20241226.pdf) | SLIM mission outcome and panel-orientation context. |
| [IAU/USGS Gazetteer: Reiner Gamma](https://planetarynames.wr.usgs.gov/Feature/4987) | Reiner Gamma representative coordinates. |
| [Artemis III multi-criteria landing-site study](https://www.sciencedirect.com/science/article/pii/S0094576524006234) | Nobile DM2 representative point. |
| [EGU25-20315](https://meetingorganizer.copernicus.org/EGU25/EGU25-20315.html) | Published Odysseus landing-site slope context. |
| [Spaceflight Now: Athena IM-2 outcome](https://spaceflightnow.com/2025/03/07/intuitive-machines-im-2-mission-ends-with-lander-on-its-side-on-the-moon/) | Reported Athena mission duration and final attitude. |
| [KUT / Firefly: Blue Ghost eclipse](https://www.kut.org/science/2025-03-14/firefly-aerospace-blue-ghost-lunar-lander-total-solar-eclipse) | Reported eclipse times and image descriptions. |
| [Space.com: Blue Ghost mission outcome](https://www.space.com/the-universe/moon/farewell-blue-ghost-private-moon-lander-goes-dark-to-end-record-breaking-commercial-lunar-mission) | Reported end of operations and night-time context. |
| [Universe Today: Odysseus lunar night](https://www.universetoday.com/articles/lunar-night-permanently-ends-the-odysseus-mission) | Wake-up listening date and mission outcome. |
| [All India Radio: Vikram sleep operations](https://www.newsonair.gov.in/vikram-lander-of-chandrayan-3-put-into-sleep-mode-hopes-for-its-awakening-on-22nd-september-isro) | Chandrayaan-3 parking and wake-up dates. |
| [Statio Shiv Shakti](https://en.wikipedia.org/wiki/Statio_Shiv_Shakti) | Landing-site name and published coordinates. |
| [Hayne et al., regolith thermophysical properties](https://arxiv.org/abs/1711.00977) | Regolith thermal-model research. |
| [Diviner project data description](https://www.diviner.ucla.edu/data) | Thermal-product interpretation and archive context. |
| [Otten et al., ICRA 2015](https://publications.ri.cmu.edu/storage/publications/2018/01/ICRA2015_Otten_3109.pdf) | Illumination-aware terrain and route-planning research. |
| [Route-planning research, arXiv:2401.08558](https://arxiv.org/abs/2401.08558) | Time-dependent lunar-route research. |
| [Tompkins, 2004](https://publications.ri.cmu.edu/storage/publications/pub_files/pub4/tompkins_paul_2004_1/tompkins_paul_2004_1.pdf) | Rover mission and resource-planning research. |
| [Rover energy research, arXiv:2509.15062](https://arxiv.org/abs/2509.15062) | Energy-aware rover research. |
| [OGC GeoTIFF 1.1](https://docs.ogc.org/is/19-008r4/19-008r4.html) | Raster registration, projection metadata and GeoTIFF import/export. |
| [GDAL slope documentation](https://gdal.org/en/stable/programs/gdal_raster_slope.html) | Horn gradient, map units and source-edge handling. |

Upcoming-mission context also uses the linked [Griffin Mission 1](https://en.wikipedia.org/wiki/Griffin_Mission_1), [IM-3](https://en.wikipedia.org/wiki/IM-3), [Blue Ghost Mission 2](https://en.wikipedia.org/wiki/Blue_Ghost_Mission_2) and [CLPS](https://en.wikipedia.org/wiki/Commercial_Lunar_Payload_Services) summaries, together with the [Chang'e 7 announcement](https://www.cislunarspace.cn/en/space-news/2026/04/2026-04-24-chang-e7-launch/).

## RoverDevKit

The rigid-wheel stress equations and grouser heuristic in `lunar/app/src/lib/mobility.ts` adapt [RoverDevKit at commit ec0b198f01bca4c8ce2892577e72e9c9c65914b5](https://github.com/Complex-Systems-Design-Lab/roverdevkit/tree/ec0b198f01bca4c8ce2892577e72e9c9c65914b5). The associated [paper](https://arxiv.org/abs/2606.21755) supplied additional model context. The MIT license and attribution are retained in [THIRD_PARTY_NOTICES.md](lunar/app/THIRD_PARTY_NOTICES.md) and the application's [served notices](lunar/app/public/third-party-notices.txt).

## Frontend tools

| Tool | Contribution |
|---|---|
| [React](https://react.dev/) and [React DOM](https://react.dev/reference/react-dom) | Interface and shared application state. |
| [TypeScript](https://www.typescriptlang.org/) | Typed application and scientific engine. |
| [Three.js](https://threejs.org/) | Interactive 3D terrain and sky views. |
| [GeoTIFF.js](https://geotiffjs.github.io/geotiff.js/) | GeoTIFF raster import and export. |
| [Vite](https://vite.dev/) | Development server and production bundling. |
| [Vitest](https://vitest.dev/) | Frontend scientific and integration regressions. |
| [Playwright](https://playwright.dev/) | Desktop browser workflow checks and screenshots. |
| [Node.js](https://nodejs.org/) and [npm](https://www.npmjs.com/) | Build, package and verification tooling. |
| [Fontsource](https://fontsource.org/) | Bundled font packages. |
| [GitHub Pages](https://docs.github.com/en/pages) and [GitHub Actions](https://docs.github.com/en/actions) | Website hosting, builds and CI. |

Exact dependency versions are recorded in [package.json](lunar/app/package.json) and [package-lock.json](lunar/app/package-lock.json).

### Fonts

- [Manrope](https://github.com/sharanda/manrope), copyright the Manrope Project Authors.
- [IBM Plex Mono](https://github.com/IBM/plex), copyright IBM Corp.

Both fonts use the SIL Open Font License. Their credits appear in [THIRD_PARTY_NOTICES.md](lunar/app/THIRD_PARTY_NOTICES.md).

## Python tools

| Tool | Contribution |
|---|---|
| [Python](https://www.python.org/) | Scientific preprocessing and verification scripts. |
| [NumPy](https://numpy.org/) | Terrain, vector and time-series arithmetic. |
| [SciPy](https://scipy.org/) | Numerical integration, interpolation, spatial algorithms and independent references. |
| [SpiceyPy](https://spiceypy.readthedocs.io/) | Python access to NAIF SPICE. |
| [HTTPX](https://www.python-httpx.org/) | Source-data requests and acquisition. |
| [Pillow](https://python-pillow.github.io/) | Raster-image processing. |
| [Rasterio](https://rasterio.readthedocs.io/) | GeoTIFF and geospatial raster verification. |
| [Shapely](https://shapely.readthedocs.io/) | Independent geometry checks for route clearance. |

Pinned versions are recorded in [requirements.txt](lunar/pipeline/requirements.txt).

## AI assistance

[Claude](https://claude.ai/) and [OpenAI Codex](https://openai.com/codex/) assisted with application development, scientific data-processing pipelines, tests, debugging, documentation and presentation text. Numerical results are calculated from the cited source datasets and explicit engineering inputs.

## Methods and evidence

[VALIDATION.md](lunar/VALIDATION.md) documents comparison methods, results and reproduction commands. [The validation directory](lunar/data/validation/) contains the source manifests and retained scientific checks.
