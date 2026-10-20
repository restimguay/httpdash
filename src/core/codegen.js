'use strict';

// Generates code snippets from a prepared request ({ method, url, headers: [[k, v]], body: Buffer|null }).
// `source` is the original request definition, used to emit idiomatic form/multipart code.

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const js = (s) => JSON.stringify(String(s));
const py = (s) => JSON.stringify(String(s));
const bodyText = (p) => (p.body ? p.body.toString('utf8') : '');
const isMultipart = (src) => src && src.body && src.body.mode === 'formdata';
const formItems = (src) => (src.body.formdata || []).filter((i) => i.enabled !== false && i.key);
const visibleHeaders = (p, src) => p.headers.filter(([k]) => !(isMultipart(src) && /^content-type$/i.test(k)) && !/^content-length$/i.test(k));

const generators = {
  curl: {
    label: 'cURL',
    lang: 'shell',
    gen(p, src) {
      const lines = [`curl --location --request ${p.method} ${sq(p.url)}`];
      for (const [k, v] of visibleHeaders(p, src)) lines.push(`--header ${sq(`${k}: ${v}`)}`);
      if (isMultipart(src)) {
        for (const i of formItems(src)) lines.push(i.type === 'file' ? `--form ${sq(`${i.key}=@"${[].concat(i.src || [])[0] || ''}"`)}` : `--form ${sq(`${i.key}=${i.value || ''}`)}`);
      } else if (src && src.body && src.body.mode === 'binary' && src.body.binary) {
        lines.push(`--data-binary ${sq('@' + src.body.binary)}`);
      } else if (p.body) lines.push(`--data-raw ${sq(bodyText(p))}`);
      return lines.join(' \\\n');
    },
  },
  httpraw: {
    label: 'HTTP',
    lang: 'http',
    gen(p) {
      const u = new URL(p.url);
      const lines = [`${p.method} ${u.pathname}${u.search} HTTP/1.1`];
      if (!p.headers.some(([k]) => /^host$/i.test(k))) lines.push(`Host: ${u.host}`);
      for (const [k, v] of p.headers) lines.push(`${k}: ${v}`);
      return lines.join('\n') + '\n\n' + bodyText(p);
    },
  },
  fetch: {
    label: 'JavaScript - Fetch',
    lang: 'javascript',
    gen(p, src) {
      const out = [];
      const headers = visibleHeaders(p, src);
      out.push('const myHeaders = new Headers();');
      for (const [k, v] of headers) out.push(`myHeaders.append(${js(k)}, ${js(v)});`);
      out.push('');
      let bodyVar = null;
      if (isMultipart(src)) {
        out.push('const formdata = new FormData();');
        for (const i of formItems(src)) out.push(i.type === 'file' ? `formdata.append(${js(i.key)}, fileInput.files[0], ${js([].concat(i.src || [])[0] || 'file')});` : `formdata.append(${js(i.key)}, ${js(i.value || '')});`);
        out.push('');
        bodyVar = 'formdata';
      } else if (p.body) {
        out.push(`const raw = ${js(bodyText(p))};`, '');
        bodyVar = 'raw';
      }
      out.push('const requestOptions = {', `  method: ${js(p.method)},`, '  headers: myHeaders,');
      if (bodyVar) out.push(`  body: ${bodyVar},`);
      out.push('  redirect: "follow"', '};', '');
      out.push(`fetch(${js(p.url)}, requestOptions)`, '  .then((response) => response.text())', '  .then((result) => console.log(result))', '  .catch((error) => console.error(error));');
      return out.join('\n');
    },
  },
  axios: {
    label: 'NodeJS - Axios',
    lang: 'javascript',
    gen(p, src) {
      const out = ["const axios = require('axios');"];
      let data = null;
      if (isMultipart(src)) {
        out.push("const FormData = require('form-data');", "const fs = require('fs');", 'const data = new FormData();');
        for (const i of formItems(src)) out.push(i.type === 'file' ? `data.append(${js(i.key)}, fs.createReadStream(${js([].concat(i.src || [])[0] || '')}));` : `data.append(${js(i.key)}, ${js(i.value || '')});`);
        data = 'data';
      } else if (p.body) {
        out.push(`const data = ${js(bodyText(p))};`);
        data = 'data';
      }
      out.push('', 'const config = {', `  method: ${js(p.method.toLowerCase())},`, '  maxBodyLength: Infinity,', `  url: ${js(p.url)},`, '  headers: {');
      const headers = visibleHeaders(p, src);
      headers.forEach(([k, v], i) => out.push(`    ${js(k)}: ${js(v)}${i < headers.length - 1 || isMultipart(src) ? ',' : ''}`));
      if (isMultipart(src)) out.push('    ...data.getHeaders()');
      out.push('  },');
      if (data) out.push(`  data: ${data}`);
      out.push('};', '', 'axios.request(config)', '  .then((response) => console.log(JSON.stringify(response.data)))', '  .catch((error) => console.log(error));');
      return out.join('\n');
    },
  },
  python: {
    label: 'Python - Requests',
    lang: 'python',
    gen(p, src) {
      const out = ['import requests', '', `url = ${py(p.url)}`, ''];
      let extra = '';
      if (isMultipart(src)) {
        const fields = formItems(src).filter((i) => i.type !== 'file');
        const files = formItems(src).filter((i) => i.type === 'file');
        out.push(`payload = {${fields.map((i) => `${py(i.key)}: ${py(i.value || '')}`).join(', ')}}`);
        out.push(`files = [${files.map((i) => `(${py(i.key)}, open(${py([].concat(i.src || [])[0] || '')}, 'rb'))`).join(', ')}]`);
        extra = ', data=payload, files=files';
      } else if (p.body) {
        out.push(`payload = ${py(bodyText(p))}`);
        extra = ', data=payload';
      }
      const headers = visibleHeaders(p, src);
      out.push('headers = {');
      headers.forEach(([k, v], i) => out.push(`  ${py(k)}: ${py(v)}${i < headers.length - 1 ? ',' : ''}`));
      out.push('}', '', `response = requests.request(${py(p.method)}, url, headers=headers${extra})`, '', 'print(response.text)');
      return out.join('\n');
    },
  },
  go: {
    label: 'Go - Native',
    lang: 'go',
    gen(p, src) {
      const hasBody = !!p.body && !isMultipart(src);
      const out = ['package main', '', 'import (', '  "fmt"', '  "io"', '  "net/http"'];
      if (hasBody) out.push('  "strings"');
      out.push(')', '', 'func main() {', `  url := ${js(p.url)}`, `  method := ${js(p.method)}`, '');
      if (hasBody) out.push(`  payload := strings.NewReader(${js(bodyText(p))})`, '');
      out.push('  client := &http.Client{}', `  req, err := http.NewRequest(method, url, ${hasBody ? 'payload' : 'nil'})`, '  if err != nil {', '    fmt.Println(err)', '    return', '  }');
      for (const [k, v] of visibleHeaders(p, src)) out.push(`  req.Header.Add(${js(k)}, ${js(v)})`);
      out.push('', '  res, err := client.Do(req)', '  if err != nil {', '    fmt.Println(err)', '    return', '  }', '  defer res.Body.Close()', '', '  body, err := io.ReadAll(res.Body)', '  if err != nil {', '    fmt.Println(err)', '    return', '  }', '  fmt.Println(string(body))', '}');
      return out.join('\n');
    },
  },
  php: {
    label: 'PHP - cURL',
    lang: 'php',
    gen(p, src) {
      const out = ['<?php', '', '$curl = curl_init();', '', 'curl_setopt_array($curl, array(', `  CURLOPT_URL => ${sq(p.url)},`, '  CURLOPT_RETURNTRANSFER => true,', '  CURLOPT_FOLLOWLOCATION => true,', `  CURLOPT_CUSTOMREQUEST => ${sq(p.method)},`];
      if (p.body && !isMultipart(src)) out.push(`  CURLOPT_POSTFIELDS => ${sq(bodyText(p)).replace(/'\\''/g, "\\'")},`);
      out.push('  CURLOPT_HTTPHEADER => array(');
      for (const [k, v] of visibleHeaders(p, src)) out.push(`    ${sq(`${k}: ${v}`).replace(/'\\''/g, "\\'")},`);
      out.push('  ),', '));', '', '$response = curl_exec($curl);', 'curl_close($curl);', 'echo $response;');
      return out.join('\n');
    },
  },
  csharp: {
    label: 'C# - HttpClient',
    lang: 'csharp',
    gen(p, src) {
      const out = ['var client = new HttpClient();', `var request = new HttpRequestMessage(new HttpMethod(${js(p.method)}), ${js(p.url)});`];
      let contentType = 'text/plain';
      for (const [k, v] of visibleHeaders(p, src)) {
        if (/^content-type$/i.test(k)) contentType = v.split(';')[0];
        else out.push(`request.Headers.TryAddWithoutValidation(${js(k)}, ${js(v)});`);
      }
      if (p.body && !isMultipart(src)) out.push(`request.Content = new StringContent(${js(bodyText(p))}, null, ${js(contentType)});`);
      out.push('var response = await client.SendAsync(request);', 'response.EnsureSuccessStatusCode();', 'Console.WriteLine(await response.Content.ReadAsStringAsync());');
      return out.join('\n');
    },
  },
  java: {
    label: 'Java - OkHttp',
    lang: 'java',
    gen(p, src) {
      const out = ['OkHttpClient client = new OkHttpClient().newBuilder().build();'];
      const ct = (p.headers.find(([k]) => /^content-type$/i.test(k)) || [, 'text/plain'])[1];
      if (p.body && !isMultipart(src)) {
        out.push(`MediaType mediaType = MediaType.parse(${js(ct)});`, `RequestBody body = RequestBody.create(mediaType, ${js(bodyText(p))});`);
      }
      out.push('Request request = new Request.Builder()', `  .url(${js(p.url)})`, `  .method(${js(p.method)}, ${p.body && !isMultipart(src) ? 'body' : 'null'})`);
      for (const [k, v] of visibleHeaders(p, src)) out.push(`  .addHeader(${js(k)}, ${js(v)})`);
      out.push('  .build();', 'Response response = client.newCall(request).execute();');
      return out.join('\n');
    },
  },
  powershell: {
    label: 'PowerShell - RestMethod',
    lang: 'powershell',
    gen(p, src) {
      const ps = (s) => `"${String(s).replace(/[`"$]/g, '`$&')}"`;
      const out = ['$headers = New-Object "System.Collections.Generic.Dictionary[[String],[String]]"'];
      for (const [k, v] of visibleHeaders(p, src)) out.push(`$headers.Add(${ps(k)}, ${ps(v)})`);
      let bodyArg = '';
      if (p.body && !isMultipart(src)) {
        out.push('', `$body = ${ps(bodyText(p))}`);
        bodyArg = ' -Body $body';
      }
      out.push('', `$response = Invoke-RestMethod ${ps(p.url)} -Method ${ps(p.method)} -Headers $headers${bodyArg}`, '$response | ConvertTo-Json');
      return out.join('\n');
    },
  },
  wget: {
    label: 'Shell - wget',
    lang: 'shell',
    gen(p, src) {
      const lines = [`wget --no-check-certificate --quiet --method ${p.method} --timeout=0`];
      for (const [k, v] of visibleHeaders(p, src)) lines.push(`--header ${sq(`${k}: ${v}`)}`);
      if (p.body && !isMultipart(src)) lines.push(`--body-data ${sq(bodyText(p))}`);
      lines.push(`-O - ${sq(p.url)}`);
      return lines.join(' \\\n  ');
    },
  },
};

function generate(target, prepared, source) {
  const g = generators[target];
  if (!g) throw new Error(`Unknown code generator: ${target}`);
  return g.gen(prepared, source);
}

const targets = () => Object.entries(generators).map(([id, g]) => ({ id, label: g.label, lang: g.lang }));

module.exports = { generate, targets };
