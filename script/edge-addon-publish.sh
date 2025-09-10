#!/bin/bash
set -e

CLIENT_ID="${EDGE_CLIENT_ID}"
API_KEY="${EDGE_CLIENT_SECRET}" # 实际是 API 密钥
PRODUCT_ID="${EDGE_PRODUCT_ID}"
FILE_PATH="${EDGE_EXTENSION_FILE}"
API_ENDPOINT="https://api.addons.microsoftedge.microsoft.com"
RETRY_LIMIT=10
RETRY_AFTER=5

# 上传扩展包
upload_resp=$(curl -i -X POST \
  -H "Authorization: ApiKey ${API_KEY}" \
  -H "Content-Type: application/zip" \
  -H "X-ClientID: ${CLIENT_ID}" \
  --data-binary @"${FILE_PATH}" \
  "${API_ENDPOINT}/v1/products/${PRODUCT_ID}/submissions/draft/package")

echo "$upload_resp"

# 提取操作ID
operation_id=$(echo "$upload_resp" | grep -Fi Location | awk '{print $2}' | tr -d '\r\n')
if [ -z "$operation_id" ]; then
  echo "上传失败，未获取到操作ID"
  exit 1
fi

# 轮询上传状态
status="InProgress"
retry=0
while [ "$status" = "InProgress" ] && [ $retry -lt $RETRY_LIMIT ]; do
  sleep $RETRY_AFTER
  status_resp=$(curl -s -X GET \
    -H "Authorization: ApiKey ${API_KEY}" \
    -H "Content-Type: application/zip" \
    -H "X-ClientID: ${CLIENT_ID}" \
    "${API_ENDPOINT}/v1/products/${PRODUCT_ID}/submissions/draft/package/operations/${operation_id}")
  status=$(echo "$status_resp" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
  echo "上传状态: $status"
  retry=$((retry+1))
done

if [ "$status" != "Succeeded" ]; then
  echo "上传未成功: $status"
  exit 1
fi

# 发布扩展
publish_resp=$(curl -i -X POST \
  -H "Authorization: ApiKey ${API_KEY}" \
  -H "Content-Type: application/json" \
  -H "X-ClientID: ${CLIENT_ID}" \
  -d '{"notes":"Auto publish from GitHub Actions"}' \
  "${API_ENDPOINT}/v1/products/${PRODUCT_ID}/submissions")

echo "$publish_resp"

publish_location=$(echo "$publish_resp" | grep -Fi Location | awk '{print $2}' | tr -d '\r\n')
if [ -z "$publish_location" ]; then
  echo "发布失败，未获取到操作ID"
  exit 1
fi

# 轮询发布状态
publish_status="InProgress"
retry=0
while [ "$publish_status" = "InProgress" ] && [ $retry -lt $RETRY_LIMIT ]; do
  sleep $RETRY_AFTER
  pub_status_resp=$(curl -s -X GET \
    -H "Authorization: ApiKey ${API_KEY}" \
    -H "Content-Type: application/json" \
    -H "X-ClientID: ${CLIENT_ID}" \
    "${API_ENDPOINT}/v1/products/${PRODUCT_ID}/submissions/operations/${publish_location}")
  publish_status=$(echo "$pub_status_resp" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
  echo "发布状态: $publish_status"
  retry=$((retry+1))
done

if [ "$publish_status" != "Succeeded" ]; then
  echo "发布未成功: $publish_status"
  exit 1
fi

echo "Edge 插件上传和发布成功！"
