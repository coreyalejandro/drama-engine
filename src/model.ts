import { db } from "./database/database";
import { ModelConfig, defaultModelConfig } from "./model-config";
import { Job } from "./job";
import { KyInstance, Options } from "ky";

export interface JobResponse {
	id: string;
	response: string | undefined;
	input_tokens: number | undefined;
	output_tokens: number | undefined;

	/** The following properties are unavailable in OpenAI-compatible response schema */
	// status: string | undefined;
	// error: string | boolean | undefined;
	// runtime: number | undefined;
}

interface requestPayload extends ModelConfig {
	prompt: string,
	preset?: string,
	chat_id?: string,
	situation_id?: string,
	interaction_id?: string
}

export class ModelError extends Error {
	reason: string;
	job: Job;
	jobResponse?: JobResponse;
	error?: Error;

	constructor(msg: string, reason: string, job: Job, jobResponse?: JobResponse, error?: Error) {
		super(msg);
		this.reason = reason;
		this.job = job;
		this.jobResponse = jobResponse;
		this.error = error;

		// Set the prototype explicitly.
		Object.setPrototypeOf(this, ModelError.prototype);
	}
}

export class Model {
	private modelConfig: ModelConfig = defaultModelConfig;
	private path: string;

	inputTokens: number = 0;
	outputTokens: number = 0;
	runtime: number = 0.0;

	constructor(path = '/api/user/writersroom/generate') {
		this.path = path;
		return this;
	}

	private jsonToJobResponse = (jsonResponse: any) => {
		try {
			const jobResponse: JobResponse = {
				id: jsonResponse.id, // job_id
				response: jsonResponse.choices[0]?.text, // generated text - change this if n > 1 in inference params
				input_tokens: jsonResponse.usage?.prompt_tokens, // runtime of the request
				output_tokens: jsonResponse.usage?.completion_tokens, // runtime of the request

				/** The following properties are unavailable in OpenAI-compatible response schema */
				// status: jsonResponse.data?.status, // job status
				// error: !jsonResponse.status ? jsonResponse.detail : false, // API-response status or a detail
				// runtime: jsonResponse.runtime, // runtime of the request
			}
			return jobResponse;
		}
		catch (error) {
			console.error('Error parsing JSON:', error);
			throw new Error("JSON Parsing error.");
		}
	}


	/**
	 * Builds a complete response object from an event-stream response.
	 *
	 * Useful, when streaming directly to user-facing components is not available.
	 *
	 * Waits for the streaming response to end and builds a response object that is the same
	 * as the response object when not streaming i.e., json response.
	 */
	private buildResponseFromStream = async (response: Response) => {
		const reader = response.body?.getReader();
		if (!reader) {
			throw new Error('Response body is not readable.');
		}

		let buffer = '';
		let completeResponse: string[] = []
		let completedData: any = null;

		const processTextStreamChunk = (chunk: Uint8Array) => {
			buffer += new TextDecoder('utf-8').decode(chunk);
			const lines = buffer.split('\r\n');

			for (let i = 0; i < lines.length - 1; i++) {
				const line = lines[i].trim();

				if (!line) continue;

				if (line.startsWith('data:')) {
					const dataMessage = line.substring(5).trim();
					// console.debug(`Data: ${dataMessage}\n`);
					if (dataMessage && dataMessage !== '[DONE]') {
						try {
							const dataObject = JSON.parse(dataMessage);
							completedData = dataObject;
							/**
							 * NOTE: In streaming, `dataObject.choices[0]?.text` contains a single token.
							 *
							 * If streaming directly to UI components, this object can be used instead
							 * of waiting for the response to end.
							 */
							completeResponse.push(dataObject.choices[0]?.text)
						} catch (error) {
							console.error('Error parsing JSON:', error);
							throw new Error("JSON Parsing error.")
						}
					}
					continue;
				}
			}

			buffer = lines[lines.length - 1];
		};

		while (true) {
			const { done, value } = await reader.read();

			if (done) {
				if (completedData) {
					completedData.choices[0].text = completeResponse.join('');
					return completedData;
				}
				throw new Error("Error in response stream or incomplete stream received.")
			}
			processTextStreamChunk(value!);
		}

	};

	private processPOSTResponse = async (response: Response): Promise<JobResponse> => {
		let jsonResponse;

		const contentType = response.headers.get('content-type');
		const responseIsStream = contentType && contentType.includes('text/event-stream')

		if (!responseIsStream) {
			jsonResponse = await response.json();
		} else {
			jsonResponse = await this.buildResponseFromStream(response);
		}

		const dataObject: JobResponse = this.jsonToJobResponse(jsonResponse);
		return dataObject;
	};


	runJob = async (job: Job, instance: KyInstance, additionalOptions?: Options): Promise<JobResponse | undefined> => {
		let jobResponse: JobResponse | undefined = undefined;

		const presetAction = job.context.action;

		if (!job.prompt) throw new ModelError("Can not run inference", "No prompt found", job);

		const postData: requestPayload = {
			prompt: job.prompt,
			preset: presetAction,
			chat_id: job.context.chatID,
			situation_id: job.context.situation,
			interaction_id: job.context.interactionID,
			...(job.modelConfig || this.modelConfig),	// job can override parameters
		}

		return instance.post(this.path, {
			json: postData,
			...additionalOptions
		}).then(async (res) => {
			jobResponse = await this.processPOSTResponse(res);

			// keep track of stats
			jobResponse.input_tokens && (this.inputTokens += jobResponse.input_tokens);
			jobResponse.output_tokens && (this.outputTokens += jobResponse.output_tokens);
			// jobResponse.runtime && (this.runtime += jobResponse.runtime);

			if (!jobResponse.id) {
				// console.info(jobResponse);
				throw new Error("Job ID not found!");
			}
			// if (jobResponse.status != "COMPLETED") {
			// 	throw new ModelError("Job failed! COMPLETED not set.", "Invalid response status.", job, jobResponse);
			// }

			db.prompts.add({ timeStamp: Date.now(), prompt: job.prompt || "No prompt found", result: jobResponse.response || "NONE", config: JSON.stringify(this.modelConfig) });

			return jobResponse;
		}).catch((e) => {
			db.prompts.add({ timeStamp: Date.now(), prompt: job.prompt || "No prompt found", result: "ERROR: " + JSON.stringify(e), config: JSON.stringify(this.modelConfig) });

			console.error(e);

			throw new ModelError("Job failed!", "Invalid response.", job, undefined, e instanceof Error ? e : undefined);
		})
	}
}