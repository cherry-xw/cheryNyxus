import { readTool } from "@/tool/read";

async function testReadTool() {
  // 打印工具定义
  console.log("=== Read Tool Definition ===");
  console.log(JSON.stringify(readTool.definition, null, 2));

  // 测试执行：读取package.json前10行
  console.log("\n=== Test 1: Read package.json (limit: 10) ===");
  const result1 = await readTool.executor.execute({
    path: "./package.json",
    limit: 10,
  });
  console.log(result1);

  // 测试执行：读取不存在的文件
  console.log("\n=== Test 2: Read non-existent file ===");
  const result2 = await readTool.executor.execute({
    path: "./non-existent.txt",
  });
  console.log(result2);

  // 测试执行：分段读取（offset: 5, limit: 5）
  console.log("\n=== Test 3: Read package.json (offset: 5, limit: 5) ===");
  const result3 = await readTool.executor.execute({
    path: "./package.json",
    offset: 5,
    limit: 5,
  });
  console.log(result3);
}

testReadTool().catch(console.error);