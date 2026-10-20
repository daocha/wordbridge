# syntax=docker/dockerfile:1

# ---- Stage 1: build the dictionary data from ECDICT ----
FROM python:3.12-slim AS data

# ECDICT is pinned to a commit so builds are reproducible.
ARG IPA_URL=https://raw.githubusercontent.com/open-dict-data/ipa-dict/41d62f55bd9c9275fcfd2843e8cf10c75e2696d7/data
ARG ECDICT_URL=https://raw.githubusercontent.com/skywind3000/ECDICT/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b/ecdict.csv
# core (~60k common words) | standard (~360k, default) | full (~760k)
ARG DICT_LEVEL=standard
# OpenCC conversion: s2tw (Traditional, Taiwan standard chars), s2hk (Hong Kong), s2twp (Taiwan phrases), s2t
ARG OPENCC_CONFIG=s2tw

RUN pip install --no-cache-dir opencc==1.4.2
WORKDIR /build
ADD ${ECDICT_URL} ecdict.csv
# British / American IPA (ipa-dict, MIT)
ADD ${IPA_URL}/en_UK.txt en_UK.txt
ADD ${IPA_URL}/en_US.txt en_US.txt
COPY scripts/build_dict.py .
RUN python build_dict.py --csv ecdict.csv --out /out/data --level "${DICT_LEVEL}" --opencc "${OPENCC_CONFIG}" \
    --ipa-uk en_UK.txt --ipa-us en_US.txt

# ---- Stage 2: fingerprint JS/CSS for cache busting ----
FROM python:3.12-slim AS web
COPY public/ /web/
COPY scripts/hash_assets.py /hash_assets.py
RUN python /hash_assets.py /web

# ---- Stage 3: static web server ----
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
# LOG_LEVEL=debug turns on per-request access logs; info (default) logs only startup and errors.
ENV LOG_LEVEL=info
COPY --chmod=755 docker/40-log-level.sh /docker-entrypoint.d/40-log-level.sh
RUN mkdir -p /etc/nginx/snippets && echo 'access_log off;' > /etc/nginx/snippets/access_log.conf
COPY --from=web /web/ /usr/share/nginx/html/
COPY --from=data /out/data /usr/share/nginx/html/data
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO /dev/null http://127.0.0.1/data/meta.json || exit 1
